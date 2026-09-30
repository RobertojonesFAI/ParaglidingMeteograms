import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compassPoint, windWindow } from "../src/lib/launches.ts";
import { historyGrid, isStale, parseWuCurrent, parseWuHistory, readWind, recentGust, type StationDocument } from "../src/lib/station.ts";
import { CURRENT_MAX_AGE_MS, serveStation, stationKey, type StationBucket } from "../worker/stations.ts";

// Samples in the format the Weather Underground PWS API documents (units=m).
const currentBody = JSON.parse(readFileSync(new URL("./fixtures/wu-current.json", import.meta.url), "utf-8"));
const historyBody = JSON.parse(readFileSync(new URL("./fixtures/wu-history.json", import.meta.url), "utf-8"));

const limits = { window: windWindow({ facingDeg: 315, windArcHalfWidthDeg: 45 }), windMinMph: 5, windMaxMph: 15, gustMaxMph: 20 };
const windowLabel = "WNW–N";

test("the current report is read into SI units", () => {
  const obs = parseWuCurrent(currentBody)!;
  assert.equal(obs.observedAt, "2026-09-30T16:28:41Z");
  assert.equal(obs.windDirectionDeg, 318);
  assert.equal(obs.windSpeedMps, 4.9); // 17.7 km/h
  assert.equal(obs.windGustMps, 6.7); // 24.1 km/h
  assert.equal(obs.temperatureC, 19.4);
  assert.equal(obs.pressureHpa, 1011.2);
  assert.equal(obs.solarRadiationWm2, 612);
  assert.equal(obs.humidityPct, 28);
  assert.equal(parseWuCurrent(null), null);
  assert.equal(parseWuCurrent({ observations: [] }), null);
});

test("imperial reports convert to the same units, and calm air has no direction", () => {
  const row = currentBody.observations[0];
  const imperial = { ...row, metric: undefined, winddir: 200, imperial: { temp: 67, dewpt: 33, windSpeed: 0, windGust: 2, pressure: 29.86, precipRate: 0, precipTotal: 0.1 } };
  const obs = parseWuCurrent({ observations: [imperial] })!;
  assert.equal(obs.temperatureC, 19.4);
  assert.equal(obs.pressureHpa, 1011.2);
  assert.equal(obs.windSpeedMps, 0);
  assert.equal(obs.windDirectionDeg, null);
  assert.equal(obs.windGustMps, 0.9);
  assert.equal(obs.precipTodayMm, 2.5);
});

test("the 5-minute history is read oldest first and placed on a regular grid with gaps", () => {
  const rows = parseWuHistory(historyBody);
  assert.equal(rows.length, 65);
  assert.equal(rows[0].validAt, "2026-09-30T10:34:59Z");
  assert.ok(Date.parse(rows[1].validAt) > Date.parse(rows[0].validAt));
  const grid = historyGrid(rows, { hours: 12, now: Date.parse("2026-09-30T16:29:00Z") });
  assert.equal(grid.length, 144);
  assert.equal(grid.at(-1)!.validAt, "2026-09-30T16:25:00Z");
  assert.equal(grid[0].validAt, "2026-09-30T04:30:00Z");
  const at = (iso: string) => grid.find((g) => g.validAt === iso)!;
  assert.equal(at("2026-09-30T13:10:00Z").windSpeedMps, null); // the station's gap
  assert.notEqual(at("2026-09-30T13:35:00Z").windSpeedMps, null);
  assert.equal(at("2026-09-30T08:00:00Z").windSpeedMps, null); // before the history starts
});

test("wind inside the window and limits reads as launchable; gusts use the last 15 minutes", () => {
  const doc = { current: parseWuCurrent(currentBody), history: parseWuHistory(historyBody) };
  const now = Date.parse("2026-09-30T16:29:00Z");
  const gust = recentGust(doc, now)!;
  // The last summaries carry gusts of about 7.8 m/s (17 mph), above the current 6.7 m/s.
  assert.ok(gust > doc.current!.windGustMps!);
  const reading = readWind(doc.current!, gust, limits, compassPoint, windowLabel)!;
  assert.equal(reading.tone, "good");
  assert.equal(reading.headline, "Within this launch's limits");
  assert.match(reading.checks[0].text, /From NW \(318°\), inside the window WNW–N/);
});

test("crosswind, strong wind, gusts and calm each get their own call", () => {
  const base = parseWuCurrent(currentBody)!;
  const cross = readWind({ ...base, windDirectionDeg: 203 }, 6, limits, compassPoint, windowLabel)!;
  assert.equal(cross.tone, "warning");
  assert.equal(cross.headline, "Outside limits: direction");
  assert.match(cross.checks[0].text, /From SSW \(203°\), outside/);

  const strong = readWind({ ...base, windSpeedMps: 8 }, 11, limits, compassPoint, windowLabel)!;
  assert.equal(strong.headline, "Outside limits: speed, gusts");

  const light = readWind({ ...base, windSpeedMps: 1.5 }, 3, limits, compassPoint, windowLabel)!;
  assert.equal(light.tone, "caution");
  assert.equal(light.headline, "Light wind");

  const calm = readWind({ ...base, windSpeedMps: 0, windDirectionDeg: null }, 0.5, limits, compassPoint, windowLabel)!;
  assert.equal(calm.headline, "Calm or nearly calm");
  assert.equal(readWind({ ...base, windSpeedMps: null }, null, limits, compassPoint, windowLabel), null);
});

test("a report older than 20 minutes is stale", () => {
  const obs = parseWuCurrent(currentBody)!;
  assert.equal(isStale(obs, Date.parse("2026-09-30T16:40:00Z")), false);
  assert.equal(isStale(obs, Date.parse("2026-09-30T16:50:00Z")), true);
  assert.equal(isStale(null, 0), true);
});

// ── the Worker endpoint ──────────────────────────────────────────────────

function memoryBucket(initial: Record<string, unknown> = {}) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const bucket: StationBucket & { objects: Map<string, string> } = {
    objects,
    async get(key) {
      const text = objects.get(key);
      return text === undefined ? null : { text: async () => text };
    },
    async put(key, value) {
      objects.set(key, value);
    },
  };
  return bucket;
}

function wu(routes: { current?: unknown; history?: unknown }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/observations/current") ? routes.current : routes.history;
    if (typeof body === "number") return new Response(body === 204 ? null : "error", { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const get = (path = "/api/stations/KIDBOISE863") => new Request(`https://example.com${path}`);
const NOW = Date.parse("2026-09-30T16:29:00Z");
const SECRET = "not-a-real-key-1234";

test("the endpoint serves only listed stations and says when the feed is not connected", async () => {
  const bucket = memoryBucket();
  assert.equal((await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "KXXXX1")).status, 404);
  assert.equal((await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "../etc")).status, 404);
  const response = await serveStation(get(), { DATA: bucket }, "KIDBOISE863");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "not connected", url: "https://www.wunderground.com/dashboard/pws/KIDBOISE863" });
});

test("the endpoint fetches both parts, keeps them in the bucket, and reuses them while fresh", async () => {
  const bucket = memoryBucket();
  let fake = wu({ current: currentBody, history: historyBody });
  let response = await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "KIDBOISE863", { now: NOW, fetchImpl: fake.fetchImpl });
  assert.equal(response.status, 200);
  const doc = (await response.json()) as StationDocument;
  assert.equal(doc.station.name, "Cervidae");
  assert.equal(doc.station.elevationM, 1219);
  assert.equal(doc.current!.windDirectionDeg, 318);
  assert.equal(doc.history.length, 65);
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls.every((u) => u.includes("stationId=KIDBOISE863") && u.includes("units=m")));
  assert.ok(bucket.objects.has(stationKey("KIDBOISE863")));
  assert.ok(!bucket.objects.get(stationKey("KIDBOISE863"))!.includes(SECRET));

  // One minute later nothing is fetched; three minutes later only the current report.
  fake = wu({ current: currentBody, history: historyBody });
  await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "KIDBOISE863", { now: NOW + 60_000, fetchImpl: fake.fetchImpl });
  assert.equal(fake.calls.length, 0);
  await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "KIDBOISE863", { now: NOW + CURRENT_MAX_AGE_MS + 60_000, fetchImpl: fake.fetchImpl });
  assert.deepEqual(fake.calls.map((u) => new URL(u).pathname), ["/v2/pws/observations/current"]);
});

test("a failing API keeps the last copy, and its errors never show the key", async () => {
  const bucket = memoryBucket();
  await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "KIDBOISE863", { now: NOW, fetchImpl: wu({ current: currentBody, history: historyBody }).fetchImpl });
  const later = NOW + 30 * 60_000;
  let response = await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "KIDBOISE863", { now: later, fetchImpl: wu({ current: 401, history: 500 }).fetchImpl });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes(SECRET));
  const doc = JSON.parse(text) as StationDocument;
  assert.equal(doc.current!.observedAt, "2026-09-30T16:28:41Z");
  assert.deepEqual(doc.errors, ["observations/current: the API key was refused (401)", "observations/all/1day: Weather Underground answered 500"]);

  // Nothing cached and nothing fetched: an error, still without the key.
  response = await serveStation(get(), { DATA: memoryBucket(), WU_API_KEY: SECRET }, "KIDBOISE863", { now: NOW, fetchImpl: wu({ current: 503, history: 503 }).fetchImpl });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(SECRET));

  // No report right now (204) keeps the previous one, which the page then shows as stale.
  response = await serveStation(get(), { DATA: bucket, WU_API_KEY: SECRET }, "KIDBOISE863", { now: later, fetchImpl: wu({ current: 204, history: historyBody }).fetchImpl });
  assert.equal(((await response.json()) as StationDocument).current!.observedAt, "2026-09-30T16:28:41Z");
});
