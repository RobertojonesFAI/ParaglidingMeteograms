import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../worker/index.ts";
import {
  handleThermalVerifications,
  isPastBoiseHour,
  MAX_REPORTS_PER_NETWORK,
  type VoteObject,
} from "../worker/thermals-verify.ts";

function createTestBucket() {
  const store = new Map<string, { value: string; customMetadata?: Record<string, string> }>();
  return {
    store,
    async get(key: string) {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        httpEtag: '"1"',
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/json");
        },
        text: async () => hit.value,
        body: new Response(hit.value).body!,
      };
    },
    async put(key: string, value: string, options?: { customMetadata?: Record<string, string> }) {
      store.set(key, { value, customMetadata: options?.customMetadata });
    },
    // Pages of two, to exercise the cursor.
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const objects: VoteObject[] = keys.slice(start, start + 2).map((key) => ({ key, customMetadata: store.get(key)!.customMetadata }));
      const truncated = start + 2 < keys.length;
      return { objects, truncated, cursor: truncated ? String(start + 2) : undefined };
    },
  };
}

// 2026-11-12T20:30:00Z is 13:30 MST in Boise.
const NOW = Date.parse("2026-11-12T20:30:00Z");
const SECRET = "test-secret";
const DEVICE_A = "device-aaaaaaaaaaaaaaaa";
const DEVICE_B = "device-bbbbbbbbbbbbbbbb";

function report(bucket: ReturnType<typeof createTestBucket>, body: Record<string, unknown>, ip = "203.0.113.10", secret = SECRET) {
  const request = new Request("https://example.com/api/thermals/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  return handleThermalVerifications(request, bucket, { now: NOW, secret });
}

function counts(bucket: ReturnType<typeof createTestBucket>, query: string, ip = "198.51.100.77") {
  const request = new Request(`https://example.com/api/thermals/verifications?${query}`, { headers: { "cf-connecting-ip": ip } });
  return handleThermalVerifications(request, bucket, { now: NOW, secret: SECRET });
}

test("isPastBoiseHour accepts hours that have ended today and all of yesterday", () => {
  assert.equal(isPastBoiseHour("2026-11-12", 12, NOW), true);
  assert.equal(isPastBoiseHour("2026-11-12", 8, NOW), true);
  assert.equal(isPastBoiseHour("2026-11-12", 13, NOW), false); // the current hour
  assert.equal(isPastBoiseHour("2026-11-12", 14, NOW), false);
  assert.equal(isPastBoiseHour("2026-11-11", 18, NOW), true);
  assert.equal(isPastBoiseHour("2026-11-13", 9, NOW), false);
  assert.equal(isPastBoiseHour("2026-11-10", 12, NOW), false);
  assert.equal(isPastBoiseHour("2026-11-11", 7, NOW), false); // outside 8..20
});

test("isPastBoiseHour finds yesterday across the DST change", () => {
  // 2026-03-09 00:30 MDT, the day after DST starts: 2026-03-08 is yesterday.
  assert.equal(isPastBoiseHour("2026-03-08", 12, Date.parse("2026-03-09T06:30:00Z")), true);
  // 2026-11-02 00:30 MST, the day after DST ends.
  assert.equal(isPastBoiseHour("2026-11-01", 12, Date.parse("2026-11-02T07:30:00Z")), true);
});

test("a report is stored without the IP or the device ID and is counted by cell", async () => {
  const bucket = createTestBucket();
  const res = await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 42, device: DEVICE_A });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { countsByCell: Record<string, number>; userVerifiedCellId: number };
  assert.deepEqual(body.countsByCell, { "42": 1 });
  assert.equal(body.userVerifiedCellId, 42);

  const [key] = [...bucket.store.keys()];
  assert.match(key, /^thermals\/verifications\/2026-11-12\/12\/[0-9a-f]{24}\.[0-9a-f]{24}$/);
  assert.equal(key.includes("203.0.113.10") || key.includes(DEVICE_A), false);

  const mine = (await (await counts(bucket, `date=2026-11-12&hour=12&device=${DEVICE_A}`)).json()) as Record<string, unknown>;
  assert.equal(mine.userVerifiedCellId, 42);
  const theirs = (await (await counts(bucket, `date=2026-11-12&hour=12&device=${DEVICE_B}`)).json()) as Record<string, unknown>;
  assert.equal(theirs.userVerified, false);
  assert.deepEqual(theirs.countsByCell, { "42": 1 });
});

test("two pilots on the same network can both report, and a pilot reporting again moves their report", async () => {
  const bucket = createTestBucket();
  assert.equal((await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 42, device: DEVICE_A })).status, 200);
  assert.equal((await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 42, device: DEVICE_B })).status, 200);
  const moved = await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 99, device: DEVICE_A });
  const body = (await moved.json()) as { countsByCell: Record<string, number>; totalVerifications: number };
  assert.deepEqual(body.countsByCell, { "42": 1, "99": 1 });
  assert.equal(body.totalVerifications, 2);
});

test("one network can report a limited number of times an hour", async () => {
  const bucket = createTestBucket();
  for (let i = 0; i < MAX_REPORTS_PER_NETWORK; i++) {
    const res = await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 5, device: `device-${String(i).padStart(16, "0")}` });
    assert.equal(res.status, 200);
  }
  const over = await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 5, device: DEVICE_B });
  assert.equal(over.status, 429);
  // Another network is not affected, nor is the hash of the same IP on another day.
  assert.equal((await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 5, device: DEVICE_B }, "192.0.2.1")).status, 200);
  assert.equal((await report(bucket, { dateIso: "2026-11-11", hour: 12, cellId: 5, device: DEVICE_B })).status, 200);
});

test("reports for hours that have not ended, or with bad fields, are refused", async () => {
  const bucket = createTestBucket();
  const cases: Array<Record<string, unknown>> = [
    { dateIso: "2026-11-12", hour: 15, cellId: 42, device: DEVICE_A },
    { dateIso: "2026-11-12", hour: 12, cellId: 0, device: DEVICE_A },
    { dateIso: "2026-11-12", hour: 12, cellId: 691, device: DEVICE_A },
    { dateIso: "2026-11-12", hour: 12, cellId: 42, device: "short" },
    { dateIso: "12/11/2026", hour: 12, cellId: 42, device: DEVICE_A },
  ];
  for (const body of cases) assert.equal((await report(bucket, body)).status, 400, JSON.stringify(body));
  assert.equal(bucket.store.size, 0);
});

test("without the secret the endpoint takes no reports", async () => {
  const bucket = createTestBucket();
  const res = await report(bucket, { dateIso: "2026-11-12", hour: 12, cellId: 42, device: DEVICE_A }, "203.0.113.10", "");
  assert.equal(res.status, 503);
  assert.equal(bucket.store.size, 0);
});

test("the Worker never serves the reports under /data", async () => {
  const bucket = createTestBucket();
  await bucket.put("thermals/verifications/2026-11-12/12/abc.json", "{}");
  const testEnv: Env = {
    ASSETS: { fetch: async () => new Response("static", { status: 200 }) },
    DATA: bucket as unknown as Env["DATA"],
  };
  const res = await worker.fetch(new Request("https://example.com/data/thermals/verifications/2026-11-12/12/abc.json"), testEnv);
  assert.equal(res.status, 404);
});
