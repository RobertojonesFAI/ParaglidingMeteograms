import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALOFT_FIELDS, SURFACE_FIELDS, aloftUrl, buildManifest, buildSiteDocument, createClient, fetchSiteDocument, metaUrl, readResponse, runFromMeta, surfaceUrl,
} from "./ecmwf.mjs";

const SITE = { slug: "cervidae-peak", name: "Cervidae Peak", latitude: 43.62332, longitude: -115.98076, timeZone: "America/Boise" };
const NOW = Date.parse("2026-09-30T04:20:00Z");
const START = Date.parse("2026-09-30T00:00:00Z") / 1000;

const UNIT_OF = { "°C": "°C", "m/s": "m/s", "°": "°", "%": "%", mm: "mm", "J/kg": "J/kg", m: "m", "W/m²": "W/m²" };

/** An Open-Meteo response for `fields` with `count` hourly steps; values from a function of (field, hour). */
function response(fields, { count = 24 * 8, value = (field, i) => i, units = {}, drop = [] } = {}) {
  const hourly = { time: Array.from({ length: count }, (_, i) => START + i * 3600) };
  const hourlyUnits = { time: "unixtime" };
  for (const [field, [name, accepted]] of Object.entries(fields)) {
    if (drop.includes(name)) continue;
    hourly[name] = hourly.time.map((_, i) => value(field, i));
    hourlyUnits[name] = units[name] ?? UNIT_OF[accepted[0]];
  }
  return { latitude: 43.625, longitude: -115.975, generationtime_ms: 1.2, utc_offset_seconds: 0, timezone: "GMT", elevation: 1271, hourly_units: hourlyUnits, hourly };
}

test("request URLs ask for the right models, fields and units", () => {
  const s = new URL(surfaceUrl(SITE));
  assert.equal(s.searchParams.get("models"), "ecmwf_ifs");
  assert.equal(s.searchParams.get("wind_speed_unit"), "ms");
  assert.equal(s.searchParams.get("timeformat"), "unixtime");
  assert.deepEqual(s.searchParams.get("hourly").split(","), Object.values(SURFACE_FIELDS).map(([n]) => n));
  assert.equal(s.searchParams.get("latitude"), "43.6233");
  const a = new URL(aloftUrl(SITE));
  assert.equal(a.searchParams.get("models"), "ecmwf_ifs025");
  assert.ok(a.searchParams.get("hourly").includes("wind_speed_850hPa"));
  assert.equal(metaUrl("ecmwf_ifs"), "https://api.open-meteo.com/data/ecmwf_ifs/static/meta.json");
});

test("a launch document starts at the current hour, merges winds aloft and keeps nulls", () => {
  const surface = response(SURFACE_FIELDS, { value: (f, i) => (f === "boundaryLayerHeightM" ? 100 * i : f === "cloudLowPct" && i === 6 ? null : i + 0.04) });
  const aloft = response(ALOFT_FIELDS, { count: 24 * 6, value: (f, i) => (f === "height850M" ? 1500 + i : 10 + i) });
  const doc = buildSiteDocument({ site: SITE, surface, aloft, runs: { surface: "2026-09-30T00:00:00Z" }, now: NOW });
  assert.equal(doc.hours[0].validAt, "2026-09-30T04:00:00Z");
  assert.equal(doc.hours[0].boundaryLayerHeightM, 400);
  assert.equal(doc.hours[0].windSpeedMps, 4);
  assert.equal(doc.hours[2].cloudLowPct, null, "a null value stays null");
  assert.equal(doc.hours[0].height850M, 1504);
  assert.equal(doc.hours.length, 7 * 24 + 1);
  // Aloft ends after 6 days; the surface hours beyond it keep empty aloft columns.
  assert.equal(doc.hours.at(-1).wind850SpeedMps, null);
  assert.equal(doc.models.surface.run, "2026-09-30T00:00:00Z");
  assert.equal(doc.models.aloft.run, null);
  assert.equal(doc.site.gridElevationM, 1271);
  assert.equal(doc.site.timeZone, "America/Boise");
});

test("hours past the model's horizon, padded with nulls, are dropped", () => {
  const surface = response(SURFACE_FIELDS, { value: (f, i) => (i > 100 ? null : i) });
  const doc = buildSiteDocument({ site: SITE, surface, aloft: null, now: NOW });
  assert.equal(doc.hours.at(-1).validAt, new Date((START + 100 * 3600) * 1000).toISOString().replace(".000Z", "Z"));
});

test("a wrong unit on a core field fails; on another field it is left empty with a warning", () => {
  assert.throws(() => readResponse(response(SURFACE_FIELDS, { units: { wind_gusts_10m: "km/h" } }), SURFACE_FIELDS, { label: "x" }), /wind_gusts_10m came in "km\/h"/);
  assert.throws(() => readResponse(response(SURFACE_FIELDS, { drop: ["boundary_layer_height"] }), SURFACE_FIELDS, { label: "x" }), /boundary_layer_height is missing/);
  const warnings = [];
  const { columns } = readResponse(response(SURFACE_FIELDS, { units: { cape: "kJ/kg" }, drop: ["shortwave_radiation"] }), SURFACE_FIELDS, { label: "x", warn: (m) => warnings.push(m) });
  assert.ok(columns.capeJkg.every((v) => v === null));
  assert.ok(columns.shortwaveWm2.every((v) => v === null));
  assert.equal(warnings.length, 2);
  assert.throws(() => readResponse({ hourly_units: { time: "iso8601" }, hourly: { time: [] } }, SURFACE_FIELDS, { label: "x" }), /unix times/);
});

test("a broken aloft response does not stop the launch", () => {
  const warnings = [];
  const doc = buildSiteDocument({ site: SITE, surface: response(SURFACE_FIELDS), aloft: { error: true }, now: NOW, warn: (m) => warnings.push(m) });
  assert.ok(doc.hours.every((h) => h.wind700SpeedMps === null));
  assert.match(warnings[0], /winds aloft left empty/);
});

test("run times come from Open-Meteo's model metadata", () => {
  assert.equal(runFromMeta({ last_run_initialisation_time: 1790726400 }), "2026-09-30T00:00:00Z");
  assert.equal(runFromMeta(null), null);
  assert.equal(runFromMeta({}), null);
});

test("the client retries rate limits, keeps Open-Meteo's reason, and the fetch tolerates missing metadata", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes("meta.json")) return new Response("not found", { status: 404 });
    if (calls === 1) return new Response("{}", { status: 429 });
    if (url.includes("ecmwf_ifs025")) return new Response(JSON.stringify({ error: true, reason: "Cannot initialize WeatherVariable from invalid String value x" }), { status: 400 });
    return Response.json(response(SURFACE_FIELDS));
  };
  const getJson = createClient({ fetchImpl, retryDelayMs: 1 });
  const warnings = [];
  const doc = await fetchSiteDocument(SITE, getJson, { now: NOW, warn: (m) => warnings.push(m) });
  assert.ok(doc.hours.length > 0);
  assert.match(warnings[0], /ecmwf_ifs025 unavailable .*answered 400: Cannot initialize/);
  assert.equal(doc.models.surface.run, null);
  const manifest = buildManifest({ now: NOW, sites: [{ slug: SITE.slug, ok: true, hours: doc.hours.length }] });
  assert.equal(manifest.sites[0].ok, true);
});
