import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../worker/index.ts";
import { refresh, type Bucket } from "../worker/refresh.ts";

const NWS = "https://api.weather.gov";
const IEM = "https://mesonet.agron.iastate.edu/json/raob.py";

/** In-memory bucket that records every write. */
function memoryBucket(initial: Record<string, unknown>) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const puts: string[] = [];
  const bucket: Bucket = {
    async get(key) {
      const text = objects.get(key);
      return text === undefined ? null : { text: async () => text };
    },
    async put(key, value) {
      puts.push(key);
      objects.set(key, value);
    },
  };
  const read = (key: string) => JSON.parse(objects.get(key) ?? "null");
  return { bucket, puts, read };
}

/** fetch stand-in answering from a URL → body table (a number is an HTTP status). */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) return new Response("not found", { status: 404 });
    const body = routes[url];
    if (typeof body === "number") return new Response("error", { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const product = (id: string, code: string, issued: string, text: string) => ({
  id,
  productCode: code,
  productName: code === "SRG" ? "Soaring Forecast" : "Area Forecast Discussion",
  issuanceTime: issued,
  text,
});

const office = (srg: ReturnType<typeof product>) => ({
  schemaVersion: 1,
  source: "National Weather Service (NOAA), api.weather.gov",
  generatedAt: "2026-09-29T23:47:02.258Z",
  office: "BOI",
  products: { afd: product("afd-1", "AFD", "2026-09-29T23:44:00+00:00", "AFD TEXT"), srg },
});

const site = { slug: "cervidae-peak", name: "Cervidae Peak", latitude: 43.62332, longitude: -115.98076, timeZone: "America/Boise" };

/** IEM answer with `n` levels from the Boise surface up. */
function iemProfile(n = 14) {
  const profile = Array.from({ length: n }, (_, i) => ({
    pres: 912 - i * 40,
    hght: 874 + i * 420,
    tmpc: 12 - i * 3,
    dwpc: 2 - i * 3,
    drct: 270,
    sknt: 10 + i,
  }));
  return { profiles: [{ station: "KBOI", valid: "2026-09-30T12:00:00Z", profile }] };
}

const sounding = (validAt: string) => ({ validAt, levels: [{ pressureHpa: 910, heightM: 874, temperatureC: 20, dewPointC: 0, windDirectionDeg: 0, windSpeedMps: 1 }] });

function dataset(overrides: Record<string, unknown> = {}) {
  return memoryBucket({
    "sites.json": { schemaVersion: 2, sites: [site] },
    "nws/manifest.json": { offices: [{ office: "BOI" }] },
    "nws/offices/BOI.json": office(product("srg-1", "SRG", "2026-09-29T13:05:00+00:00", "OLD SRG")),
    "raob/sites/cervidae-peak.json": { schemaVersion: 1, soundings: [sounding("2026-09-30T00:00:00Z"), sounding("2026-09-29T12:00:00Z")] },
    ...overrides,
  });
}

const lists = (srgId: string) => ({
  [`${NWS}/products/types/AFD/locations/BOI`]: { "@graph": [{ id: "afd-1" }] },
  [`${NWS}/products/types/SRG/locations/BOI`]: { "@graph": [{ id: srgId }] },
});

test("a new Soaring Forecast replaces the published one; the unchanged AFD is not downloaded", async () => {
  const data = dataset();
  const { fetchImpl, calls } = fakeFetch({
    ...lists("srg-2"),
    [`${NWS}/products/srg-2`]: { id: "srg-2", productCode: "SRG", productName: "Soaring Forecast", issuanceTime: "2026-09-30T13:05:00+00:00", productText: "NEW SRG" },
  });
  const status = await refresh(data.bucket, { now: Date.parse("2026-09-30T13:10:00Z"), fetchImpl, retryDelayMs: 1 });
  const doc = data.read("nws/offices/BOI.json");
  assert.equal(doc.products.srg.text, "NEW SRG");
  assert.equal(doc.products.afd.text, "AFD TEXT");
  assert.equal(doc.generatedAt, "2026-09-30T13:10:00.000Z");
  assert.ok(!calls.includes(`${NWS}/products/afd-1`));
  assert.deepEqual(status.offices, [{ office: "BOI", afdIssuanceTime: "2026-09-29T23:44:00+00:00", srgIssuanceTime: "2026-09-30T13:05:00+00:00", updated: true }]);
  assert.equal(data.read("status/refresh.json").ranAt, "2026-09-30T13:10:00Z");
});

test("nothing is rewritten when NWS has nothing new, or when it fails", async () => {
  let data = dataset();
  let fake = fakeFetch(lists("srg-1"));
  let status = await refresh(data.bucket, { now: Date.parse("2026-09-30T12:20:00Z"), fetchImpl: fake.fetchImpl, retryDelayMs: 1 });
  assert.ok(!data.puts.includes("nws/offices/BOI.json"));
  assert.equal(status.offices[0].updated, false);

  data = dataset();
  fake = fakeFetch({ [`${NWS}/products/types/AFD/locations/BOI`]: 503, [`${NWS}/products/types/SRG/locations/BOI`]: 503 });
  status = await refresh(data.bucket, { now: Date.parse("2026-09-30T12:20:00Z"), fetchImpl: fake.fetchImpl, retryDelayMs: 1 });
  assert.ok(!data.puts.includes("nws/offices/BOI.json"));
  assert.equal(data.read("nws/offices/BOI.json").products.srg.text, "OLD SRG");
  assert.equal(status.offices[0].srgIssuanceTime, "2026-09-29T13:05:00+00:00");
  assert.match(status.offices[0].error ?? "", /keeping the previous one/);
});

test("the morning balloon is fetched once due and goes in front of last evening's", async () => {
  // 12:30 UTC: too early to look for the 12 UTC flight.
  let data = dataset();
  let fake = fakeFetch(lists("srg-1"));
  await refresh(data.bucket, { now: Date.parse("2026-09-30T12:30:00Z"), fetchImpl: fake.fetchImpl, retryDelayMs: 1 });
  assert.ok(!fake.calls.some((u) => u.startsWith(IEM)));

  // 13:00 UTC: due, and the archive has it.
  data = dataset();
  fake = fakeFetch({ ...lists("srg-1"), [`${IEM}?ts=202609301200&station=KBOI`]: iemProfile() });
  const status = await refresh(data.bucket, { now: Date.parse("2026-09-30T13:00:00Z"), fetchImpl: fake.fetchImpl, retryDelayMs: 1 });
  const doc = data.read("raob/sites/cervidae-peak.json");
  assert.deepEqual(doc.soundings.map((s: { validAt: string }) => s.validAt), ["2026-09-30T12:00:00Z", "2026-09-30T00:00:00Z"]);
  assert.equal(doc.station.id, "KBOI");
  assert.equal(doc.soundings[0].levels.length, 14);
  assert.deepEqual(status.balloons, [{ station: "KBOI", published: "2026-09-30T00:00:00Z", due: "2026-09-30T12:00:00Z", updated: ["cervidae-peak"] }]);
});

test("a flight the archive does not have is retried, hourly after four hours", async () => {
  const empty = { profiles: [{ station: "KBOI", profile: [] }] };
  let data = dataset();
  let fake = fakeFetch({ ...lists("srg-1"), [`${IEM}?ts=202609301200&station=KBOI`]: empty });
  let status = await refresh(data.bucket, { now: Date.parse("2026-09-30T14:00:00Z"), fetchImpl: fake.fetchImpl, retryDelayMs: 1 });
  assert.equal(status.balloons[0].note, "not in the archive yet");
  assert.ok(!data.puts.includes("raob/sites/cervidae-peak.json"));

  data = dataset();
  fake = fakeFetch({ ...lists("srg-1"), [`${IEM}?ts=202609301200&station=KBOI`]: empty });
  status = await refresh(data.bucket, { now: Date.parse("2026-09-30T17:20:00Z"), fetchImpl: fake.fetchImpl, retryDelayMs: 1 });
  assert.equal(status.balloons[0].note, "not in the archive yet; checking once an hour");
  assert.ok(!fake.calls.some((u) => u.startsWith(IEM)));

  status = await refresh(data.bucket, { now: Date.parse("2026-09-30T18:00:00Z"), fetchImpl: fake.fetchImpl, retryDelayMs: 1 });
  assert.ok(fake.calls.some((u) => u.startsWith(IEM)));
});

test("the Worker's scheduled handler runs the refresh", async () => {
  const data = dataset();
  const pending: Promise<unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(lists("srg-1")).fetchImpl;
  try {
    const env = { ASSETS: { fetch: async () => new Response("") }, DATA: data.bucket } as unknown as Env;
    await worker.scheduled({ scheduledTime: Date.parse("2026-09-30T12:20:00Z") }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(data.read("status/refresh.json").ranAt, "2026-09-30T12:20:00Z");
});
