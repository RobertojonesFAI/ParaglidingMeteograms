import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../worker/index.ts";
import { handleThermalVerifications, isPastBoiseHour, verificationKey } from "../worker/thermals-verify.ts";

function createTestBucket(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    async get(key: string) {
      if (!(key in store)) return null;
      const body = store[key];
      return {
        httpEtag: `"${body.length}"`,
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/json");
        },
        text: async () => body,
        body: new Response(body).body!,
      };
    },
    async put(key: string, value: string) {
      store[key] = value;
    },
  };
}

// 2026-11-12T20:30:00Z is 2026-11-12 13:30:00 MST (America/Boise, UTC-7 in November)
const FIXED_NOW_MS = Date.parse("2026-11-12T20:30:00Z");

test("isPastBoiseHour allows completed today hours and all yesterday hours, and rejects current/future hours", () => {
  // At 13:30 MST on 2026-11-12:
  assert.equal(isPastBoiseHour("2026-11-12", 12, FIXED_NOW_MS), true);
  assert.equal(isPastBoiseHour("2026-11-12", 8, FIXED_NOW_MS), true);
  assert.equal(isPastBoiseHour("2026-11-12", 13, FIXED_NOW_MS), false); // current hour
  assert.equal(isPastBoiseHour("2026-11-12", 14, FIXED_NOW_MS), false); // future hour
  assert.equal(isPastBoiseHour("2026-11-11", 18, FIXED_NOW_MS), true); // yesterday
  assert.equal(isPastBoiseHour("2026-11-13", 9, FIXED_NOW_MS), false); // tomorrow
  assert.equal(isPastBoiseHour("2026-11-10", 12, FIXED_NOW_MS), false); // older than yesterday
});

test("POST /api/thermals/verify records IP + timestamp once per user per hour and rejects duplicates or future hours", async () => {
  const bucket = createTestBucket();

  // 1. Future hour (15:00 when current hour is 13:00) -> 400
  const futureReq = new Request("https://example.com/api/thermals/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
    body: JSON.stringify({ dateIso: "2026-11-12", hour: 15, cellId: 42 }),
  });
  const futureRes = await handleThermalVerifications(futureReq, bucket, { now: FIXED_NOW_MS });
  assert.equal(futureRes.status, 400);

  // 2. Past hour (12:00) from IP #1 -> 200
  const validReq = new Request("https://example.com/api/thermals/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
    body: JSON.stringify({ dateIso: "2026-11-12", hour: 12, cellId: 42 }),
  });
  const validRes = await handleThermalVerifications(validReq, bucket, { now: FIXED_NOW_MS });
  assert.equal(validRes.status, 200);
  const validBody = (await validRes.json()) as {
    ok: boolean;
    userVerified: boolean;
    userVerifiedCellId: number;
    countsByCell: Record<string, number>;
    timestamp: string;
  };
  assert.equal(validBody.ok, true);
  assert.equal(validBody.userVerified, true);
  assert.equal(validBody.userVerifiedCellId, 42);
  assert.deepEqual(validBody.countsByCell, { "42": 1 });
  assert.equal(validBody.timestamp, "2026-11-12T20:30:00.000Z");

  // Stored R2 JSON has ip and timestamp recorded
  const rawStored = JSON.parse(bucket.store[verificationKey("2026-11-12")]);
  assert.deepEqual(rawStored.hours["12"].entries, [
    { cellId: 42, ip: "203.0.113.10", timestamp: "2026-11-12T20:30:00.000Z" },
  ]);

  // 3. Duplicate submission by same IP in the same hour (even for another cell) -> 409
  const dupReq = new Request("https://example.com/api/thermals/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
    body: JSON.stringify({ dateIso: "2026-11-12", hour: 12, cellId: 99 }),
  });
  const dupRes = await handleThermalVerifications(dupReq, bucket, { now: FIXED_NOW_MS });
  assert.equal(dupRes.status, 409);
  const dupBody = (await dupRes.json()) as { userVerifiedCellId: number; countsByCell: Record<string, number> };
  assert.equal(dupBody.userVerifiedCellId, 42);
  assert.deepEqual(dupBody.countsByCell, { "42": 1 });

  // 4. Same IP in a DIFFERENT past hour (11:00) -> 200 allowed
  const otherHourReq = new Request("https://example.com/api/thermals/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
    body: JSON.stringify({ dateIso: "2026-11-12", hour: 11, cellId: 99 }),
  });
  const otherHourRes = await handleThermalVerifications(otherHourReq, bucket, { now: FIXED_NOW_MS });
  assert.equal(otherHourRes.status, 200);

  // 5. GET /api/thermals/verifications returns counts without leaking raw IPs
  const getReq = new Request("https://example.com/api/thermals/verifications?date=2026-11-12&hour=12", {
    headers: { "cf-connecting-ip": "198.51.100.77" },
  });
  const getRes = await handleThermalVerifications(getReq, bucket, { now: FIXED_NOW_MS });
  assert.equal(getRes.status, 200);
  const getText = await getRes.text();
  assert.equal(getText.includes("203.0.113.10"), false);
  const getBody = JSON.parse(getText);
  assert.equal(getBody.userVerified, false);
  assert.deepEqual(getBody.countsByCell, { "42": 1 });
});

test("Worker blocks direct /data/thermals/verifications/* access so raw IPs stay private", async () => {
  const bucket = createTestBucket({
    "thermals/verifications/2026-11-12.json": '{"secret":"203.0.113.10"}',
  });
  const testEnv: Env = {
    ASSETS: { fetch: async () => new Response("static", { status: 200 }) },
    DATA: bucket as unknown as Env["DATA"],
  };
  const res = await worker.fetch(new Request("https://example.com/data/thermals/verifications/2026-11-12.json"), testEnv);
  assert.equal(res.status, 404);
});

