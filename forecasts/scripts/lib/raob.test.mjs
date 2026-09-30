import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSiteDocument, createClient, fetchStationSoundings, nearestStation, normalizeProfile, recentLaunchTimes, soundingUrl } from "./raob.mjs";

const CERVIDAE = { slug: "cervidae-peak", name: "Cervidae Peak", latitude: 43.62332, longitude: -115.98076 };

test("Cervidae uses the Boise balloon; far-away launches get none", () => {
  const s = nearestStation(CERVIDAE);
  assert.equal(s.id, "KBOI");
  assert.equal(s.distanceKm, 20);
  assert.equal(nearestStation({ latitude: 46.5, longitude: 7.9 }), null);
});

test("launch times are 00 and 12 UTC, newest first, and URLs follow IEM's format", () => {
  const times = recentLaunchTimes(Date.parse("2026-09-30T05:10:00Z"), 3).map((t) => new Date(t).toISOString());
  assert.deepEqual(times, ["2026-09-30T00:00:00.000Z", "2026-09-29T12:00:00.000Z", "2026-09-29T00:00:00.000Z"]);
  assert.equal(soundingUrl("KBOI", Date.parse("2026-09-29T12:00:00Z")), "https://mesonet.agron.iastate.edu/json/raob.py?ts=202609291200&station=KBOI");
});

const level = (pres, hght, tmpc, dwpc, drct, sknt) => ({ pres, hght, tmpc, dwpc, drct, sknt });

test("profiles are cleaned: missing values, duplicates, out-of-order heights and high levels", () => {
  const levels = normalizeProfile([
    level(912, 874, 8.5, 2.1, 345, 2),
    level(900, 990, 11.0, -1.0, null, null),
    level(900, 991, 11.0, -1.0, 330, 4),
    level(850, 1480, 13.3, -4.2, 330, 16),
    level(840, 1400, 12.0, -5, 330, 16), // height out of order
    level(700, null, -1, -8, 300, 20),
    level(500, 5790, -11.8, -30, 335, 25),
    level(200, 12000, -55, -70, 350, 46), // above the top kept
  ]);
  // 700 hPa had no height: it gets one between its neighbours instead of being dropped.
  assert.deepEqual(levels.map((l) => l.pressureHpa), [912, 900, 850, 700, 500]);
  assert.ok(levels[3].heightM > 1480 && levels[3].heightM < 5790);
  assert.equal(levels[1].windSpeedMps, null);
  assert.equal(levels[2].windSpeedMps, 8.2);
  assert.equal(levels[0].dewPointC, 2.1);
});

test("significant levels without a height get one from the hypsometric equation", () => {
  const levels = normalizeProfile([
    level(913, 874, 23.8, -0.2, 290, 9),
    level(888, null, 20, -1, null, null),
    level(850, 1570, 17, -2, 315, 11),
  ]);
  assert.equal(levels.length, 3);
  // 874 m + (Rd/g) * 295 K * ln(913/888) ≈ 874 + 240 m.
  assert.ok(Math.abs(levels[1].heightM - 1114) < 3, `${levels[1].heightM}`);
});

test("the fetch keeps the two latest usable soundings", async () => {
  const full = Array.from({ length: 30 }, (_, i) => level(910 - i * 20, 874 + i * 200, 10 - i, 0 - i, 330, 10));
  const calls = [];
  const getJson = async (url) => {
    calls.push(url);
    if (url.includes("202609300000")) return { profiles: [] }; // evening balloon not in yet
    return { profiles: [{ station: "KBOI", valid: "x", profile: full }] };
  };
  const soundings = await fetchStationSoundings({ id: "KBOI" }, getJson, { now: Date.parse("2026-09-30T00:40:00Z") });
  assert.deepEqual(soundings.map((s) => s.validAt), ["2026-09-29T12:00:00Z", "2026-09-29T00:00:00Z"]);
  assert.equal(calls.length, 3);
  const doc = buildSiteDocument({ site: CERVIDAE, station: { ...nearestStation(CERVIDAE) }, soundings });
  assert.equal(doc.station.elevationM, 874);
  assert.equal(doc.soundings.length, 2);
});

test("the client retries server errors and treats 404 as no data", async () => {
  let n = 0;
  const getJson = createClient({ retryDelayMs: 1, fetchImpl: async (url) => (url.includes("missing") ? new Response("", { status: 404 }) : ++n < 2 ? new Response("", { status: 503 }) : Response.json({ ok: 1 })) });
  assert.deepEqual(await getJson("https://x/ok"), { ok: 1 });
  assert.equal(await getJson("https://x/missing"), null);
});
