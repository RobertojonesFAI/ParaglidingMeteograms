// Builds the local sample dataset served at /data during `pnpm dev`.
//
// Every document is synthetic: the meteogram profiles are meteo's
// "convective-cycle" scenario re-timed onto today's local days for each launch
// in ../forecasts/sites.json, and the NWS documents come from a made-up grid
// run through the same builder the NWS workflow uses. Each document is checked
// with the contract parsers the site uses in production.
//
// Usage: node scripts/make-dev-data.mjs [--out dev-data]

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  parseForecastManifestJson,
  parseModelCatalogueJson,
  parseRunsIndexJson,
  parseSiteContextJson,
  parseSiteForecastJson,
  parseSitesCatalogueJson,
  siteForecastSchema,
} from "@azohra/meteo.briefing/contract";
import { buildManifest, buildSiteDocument, paths as nwsPaths } from "../../forecasts/scripts/lib/nws.mjs";
import { buildSolarTerrain, domainFor, expandBounds, gridFromFunction, metresPerDegree } from "../../forecasts/scripts/lib/solar.mjs";
import { ALOFT_FIELDS, SURFACE_FIELDS, buildManifest as buildEcmwfManifest, buildSiteDocument as buildEcmwfDocument, paths as ecmwfPaths } from "../../forecasts/scripts/lib/ecmwf.mjs";
import { SCHEMA_VERSION as STATION_SCHEMA, SOURCE as STATION_SOURCE, dashboardUrl, parseWuCurrent, parseWuHistory } from "../src/lib/station.ts";

const { values: args } = parseArgs({ options: { out: { type: "string", default: "dev-data" } } });
const out = resolve(args.out);
const HOUR = 3_600_000;
const HEIGHT_SHIFT_M = 480; // scenario terrain 900 m -> sample launch terrain 1380 m
const LAUNCH_ELEVATION_M = 1480;

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8"));
const sites = readJson("../../forecasts/sites.json");
const models = readJson("../dev-data-src/models.json");
const scenario = readJson("../dev-data-src/convective-cycle.profile.json");
const ensembleScenario = readJson("../dev-data-src/ensemble-wide.profile.json");

function write(key, value, parse) {
  const text = `${JSON.stringify(value, null, 1)}\n`;
  if (parse && parse(text) === null) throw new Error(`${key} fails the contract guard`);
  const file = join(out, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// Local midnight today in a time zone, as epoch ms (good to the hour).
function localMidnight(timeZone, now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return Math.floor(now / HOUR) * HOUR - Number(parts.hour) * HOUR;
}

const localHour = (timeZone, t) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" }).format(new Date(t)));

const shiftHeight = (value) => (typeof value === "number" ? Math.round((value + HEIGHT_SHIFT_M) * 10) / 10 : value);

// One synthetic profile hour for launch-local hour L on day index d.
function profileHour(t, timeZone, day) {
  const L = localHour(timeZone, t);
  const source = scenario.hours[Math.min(9, Math.max(0, L - 9))];
  const hour = structuredClone(source);
  hour.validAt = new Date(t).toISOString().replace(".000Z", "Z");
  const windy = day % 2 === 1;
  const turn = (deg) => (windy ? (deg + 130) % 360 : deg); // day 2: north-westerly flow
  const blow = (mps) => (windy ? Math.round(mps * 1.5 * 100) / 100 : mps);
  hour.surface.windDirectionDeg = turn(hour.surface.windDirectionDeg);
  hour.surface.windSpeedMps = blow(hour.surface.windSpeedMps);
  if (typeof hour.surface.windGustMps === "number") hour.surface.windGustMps = blow(hour.surface.windGustMps);
  for (const level of hour.levels) {
    level.heightM = shiftHeight(level.heightM);
    level.windDirectionDeg = turn(level.windDirectionDeg);
    level.windSpeedMps = blow(level.windSpeedMps);
  }
  for (const key of ["boundaryLayerTopM", "cloudBaseM", "usableLiftTopM"]) hour.derived[key] = shiftHeight(hour.derived[key]);
  return hour;
}

function profile(model, site, referenceTime, stepHours, count) {
  const entry = models.models.find((m) => m.slug === model);
  const hours = [];
  const midnight = localMidnight(site.timeZone, referenceTime);
  for (let i = 1; i <= count; i += 1) {
    const t = referenceTime + i * stepHours * HOUR;
    hours.push(profileHour(t, site.timeZone, Math.floor((t - midnight) / (24 * HOUR))));
  }
  const doc = {
    schemaVersion: 2,
    model,
    run: { referenceTime: iso(referenceTime), generatedAt: iso(referenceTime + 2 * HOUR) },
    site: {
      id: site.slug,
      name: site.name,
      latitude: site.latitude,
      longitude: site.longitude,
      modelElevationM: shiftHeight(scenario.site.modelElevationM),
      timeZone: site.timeZone,
    },
    semantics: { gust: entry.capabilities.gust, precipitation: entry.capabilities.precipitation },
    hours,
  };
  const check = siteForecastSchema.safeParse(doc);
  if (!check.success) throw new Error(`${model}/${site.slug}: ${check.error.message}`);
  return doc;
}

const iso = (t) => new Date(t).toISOString().replace(".000Z", "Z");

// Ensemble sample: meteo's "ensemble-wide" scenario (percentile blocks per
// field) re-timed onto local days; values are left as the scenario has them.
function ensembleProfile(model, site, referenceTime, stepHours, count) {
  const entry = models.models.find((m) => m.slug === model);
  const hours = [];
  for (let i = 1; i <= count; i += 1) {
    const t = referenceTime + i * stepHours * HOUR;
    const L = localHour(site.timeZone, t);
    const source = ensembleScenario.hours[Math.min(5, Math.max(0, Math.round(((L - 7) / 14) * 5)))];
    hours.push({ ...structuredClone(source), validAt: iso(t) });
  }
  const doc = {
    schemaVersion: 2,
    model,
    run: { referenceTime: iso(referenceTime), generatedAt: iso(referenceTime + 2 * HOUR), members: ensembleScenario.run.members },
    site: { ...ensembleScenario.site, id: site.slug, name: site.name, latitude: site.latitude, longitude: site.longitude, timeZone: site.timeZone },
    semantics: { ...ensembleScenario.semantics, precipitation: entry.capabilities.precipitation },
    hours,
  };
  const check = siteForecastSchema.safeParse(doc);
  if (!check.success) throw new Error(`${model}/${site.slug}: ${check.error.message}`);
  return doc;
}

// ── build ────────────────────────────────────────────────────────────────

rmSync(out, { recursive: true, force: true });
const now = Date.now();
const zone = sites.sites[0]?.timeZone ?? "America/Boise";
// Runs start at local midnight so the sample covers whole local days.
const hrrrRef = localMidnight(zone, now);
const gfsRef = hrrrRef;
const runs = {};

write("sites.json", sites, parseSitesCatalogueJson);
write("models.json", models, parseModelCatalogueJson);

for (const [model, ref, step, count, build] of [
  ["hrrr-conus", hrrrRef, 1, 48, profile],
  ["gfs", gfsRef, 3, 56, profile],
  ["geps", gfsRef, 3, 56, ensembleProfile],
]) {
  for (const site of sites.sites) write(`${model}/sites/${site.slug}.json`, build(model, site, ref, step, count), parseSiteForecastJson);
  const generatedAt = new Date(ref + 2 * HOUR).toISOString();
  write(
    `${model}/manifest.json`,
    {
      schemaVersion: 1,
      model,
      referenceTime: iso(ref),
      generatedAt,
      firstForecastHour: step,
      lastForecastHour: step * count,
      forecastHours: count,
      sites: sites.sites.map((s) => ({ slug: s.slug, name: s.name })),
      stats: { downloadBytes: 0, downloads: 0, durationMs: 0, retries: 0 },
    },
    parseForecastManifestJson,
  );
  runs[model] = { referenceTime: iso(ref), generatedAt };
}
write("runs.json", { schemaVersion: 1, runs }, parseRunsIndexJson);

write(
  "site-context.json",
  {
    schemaVersion: 3,
    generatedAt: iso(hrrrRef),
    sources: [
      {
        id: "glo30",
        product: "Copernicus GLO-30 DEM",
        kind: "surfaceModel",
        resolutionM: 30,
        licence: "Copernicus DEM licence",
        attribution: "Sample data",
        url: "https://registry.opendata.aws/copernicus-dem/",
      },
      {
        id: "worldcover2021",
        product: "ESA WorldCover 10 m 2021 v200",
        kind: "landCover",
        resolutionM: 10,
        licence: "CC-BY 4.0",
        attribution: "Sample data",
        url: "https://zenodo.org/records/7254221",
      },
    ],
    sites: Object.fromEntries(
      sites.sites.map((s) => [
        s.slug,
        {
          point: { latitude: s.latitude, longitude: s.longitude },
          elevation: { source: "glo30", elevationM: LAUNCH_ELEVATION_M },
          terrain: {
            source: "glo30",
            elevationM: LAUNCH_ELEVATION_M,
            slopeDeg: 18,
            aspectDeg: 315,
            relief: [{ radiusKm: 1, minM: 1100, maxM: 1520, percentile: 85 }],
          },
          landCover: {
            source: "worldcover2021",
            atLaunch: "shrubland",
            fractions: [{ radiusKm: 1, byClass: { shrubland: 0.8, grassland: 0.2 } }],
          },
        },
      ]),
    ),
  },
  parseSiteContextJson,
);

// ── NWS (same builder as forecasts/scripts/nws.mjs) ─────────────────────

function nwsGrid(site) {
  const start = localMidnight(site.timeZone, now);
  const layers = {};
  const add = (name, uom, fn) => {
    layers[name] = {
      uom,
      values: Array.from({ length: 7 * 24 }, (_, i) => {
        const t = start + i * HOUR;
        return { validTime: `${new Date(t).toISOString().replace(".000Z", "+00:00")}/PT1H`, value: fn(localHour(site.timeZone, t), Math.floor(i / 24)) };
      }),
    };
  };
  const day = (L) => Math.max(0, Math.sin(((L - 6) / 14) * Math.PI)); // 0 at night, 1 mid-afternoon
  add("temperature", "wmoUnit:degC", (L, d) => Math.round((8 + 16 * day(L) - d) * 10) / 10);
  add("dewpoint", "wmoUnit:degC", () => 1.5);
  add("relativeHumidity", "wmoUnit:percent", (L) => Math.round(70 - 45 * day(L)));
  add("skyCover", "wmoUnit:percent", (L, d) => (d === 2 ? 55 : Math.round(10 + 25 * day(L))));
  add("windDirection", "wmoUnit:degree_(angle)", (L, d) => (L >= 10 && L <= 19 ? (d % 2 ? 300 : 325) : 140));
  add("windSpeed", "wmoUnit:km_h-1", (L, d) => Math.round((6 + 16 * day(L) * (d % 2 ? 1.6 : 1)) * 10) / 10);
  add("windGust", "wmoUnit:km_h-1", (L, d) => Math.round((10 + 26 * day(L) * (d % 2 ? 1.7 : 1)) * 10) / 10);
  add("probabilityOfPrecipitation", "wmoUnit:percent", (L, d) => (d === 2 && L >= 13 && L <= 18 ? 30 : 5));
  add("probabilityOfThunder", "wmoUnit:percent", (L, d) => (d === 2 && L >= 13 && L <= 18 ? 20 : 0));
  add("lightningActivityLevel", "nwsUnit:n/a", (L, d) => (d === 2 && L >= 13 && L <= 18 ? 3 : 1));
  add("mixingHeight", "wmoUnit:m", (L, d) => Math.round(150 + 2700 * day(L) * (d === 2 ? 0.8 : 1)));
  add("transportWindDirection", "wmoUnit:degree_(angle)", (L, d) => (d % 2 ? 295 : 250));
  add("transportWindSpeed", "wmoUnit:km_h-1", (L, d) => Math.round((10 + 12 * day(L) * (d % 2 ? 1.8 : 1)) * 10) / 10);
  add("ceilingHeight", "wmoUnit:m", (L, d) => (d === 2 ? 3000 : null));
  add("visibility", "wmoUnit:m", () => 16093);
  add("weather", "nwsUnit:n/a", (L, d) =>
    d === 2 && L >= 13 && L <= 18 ? [{ coverage: "slight_chance", weather: "thunderstorms", intensity: null, attributes: [] }] : [{ coverage: null, weather: null, intensity: null, attributes: [] }],
  );
  return {
    properties: { updateTime: new Date(now - HOUR).toISOString(), elevation: { unitCode: "wmoUnit:m", value: 1402 }, ...layers },
  };
}

const siteEntries = [];
for (const site of sites.sites) {
  const point = { properties: { gridId: "BOI", gridX: 150, gridY: 86 } };
  const start = localMidnight(site.timeZone, now);
  const hourly = {
    properties: {
      updateTime: new Date(now - HOUR).toISOString(),
      periods: Array.from({ length: 7 * 24 }, (_, i) => ({
        startTime: new Date(start + i * HOUR).toISOString(),
        shortForecast: Math.floor(i / 24) === 2 && i % 24 >= 13 && i % 24 <= 18 ? "Slight Chance T-storms" : "Sunny",
      })),
    },
  };
  const forecast = {
    properties: {
      updateTime: new Date(now - HOUR).toISOString(),
      periods: ["Today", "Tonight", "Tomorrow", "Tomorrow Night"].map((name, i) => ({
        name,
        startTime: new Date(start + (6 + i * 12) * HOUR).toISOString(),
        endTime: new Date(start + (18 + i * 12) * HOUR).toISOString(),
        isDaytime: i % 2 === 0,
        shortForecast: i % 2 ? "Clear" : "Sunny",
        detailedForecast: `Sample text, not a forecast. ${i % 2 ? "Clear, with a low around 45." : "Sunny, with a high near 75. Northwest wind 5 to 10 mph."}`,
      })),
    },
  };
  const doc = buildSiteDocument({ site, point, grid: nwsGrid(site), hourly, forecast, now });
  write(nwsPaths.site(site.slug), doc);
  siteEntries.push({ slug: site.slug, ok: true, office: "BOI", updateTime: doc.updateTime });
}
write(nwsPaths.office("BOI"), {
  schemaVersion: 1,
  source: "National Weather Service (NOAA), api.weather.gov",
  generatedAt: new Date(now).toISOString(),
  office: "BOI",
  products: {
    afd: {
      id: "sample",
      productCode: "AFD",
      productName: "Area Forecast Discussion",
      issuanceTime: new Date(now - 3 * HOUR).toISOString(),
      text: "SAMPLE AREA FORECAST DISCUSSION\nThis is sample text for local development. It is not a forecast.\n\n.SHORT TERM...\nHigh pressure keeps skies mostly clear. Afternoon northwest winds 10 to 15 mph over the ridges.\n",
    },
    // A real Boise Soaring Forecast (29 September 2026), kept as a test fixture.
    srg: {
      id: "sample",
      productCode: "SRG",
      productName: "Soaring Forecast",
      issuanceTime: "2026-09-29T13:05:00Z",
      text: readFileSync(new URL("../test/fixtures/srg-boi.txt", import.meta.url), "utf-8"),
    },
  },
});

// Weather balloon: the Soaring Forecast's morning table as a balloon file, with
// a synthetic dew point (the table has none), plus an evening flight.
{
  const srgText = readFileSync(new URL("../test/fixtures/srg-boi.txt", import.meta.url), "utf-8");
  const lines = srgText.split("\n");
  const rows = lines
    .slice(lines.findIndex((l) => l.includes("Upper air data")), lines.findIndex((l) => l.includes("Numerical weather prediction")))
    .map((l) => l.trim().split(/\s+/))
    .filter((t) => t.length >= 13 && /^\d+$/.test(t[0]) && t[1] !== "M")
    .map((t) => ({ z: Number(t[0]) / 3.28084, t: Number(t[1]), dir: Number(t[3]), kt: Number(t[4]) }))
    .sort((a, b) => a.z - b.z);
  const flight = (validAt, warm) => {
    let p = 913;
    const levels = [];
    rows.forEach((r, i) => {
      const z = i === 0 ? 874 : r.z;
      const t = r.t + warm * Math.max(0, 1 - (z - 874) / 2500);
      if (i > 0) p *= Math.exp((-9.80665 * (z - levels[i - 1].heightM)) / (287.04 * ((levels[i - 1].temperatureC + t) / 2 + 273.15)));
      levels.push({ pressureHpa: Math.round(p * 10) / 10, heightM: Math.round(z), temperatureC: Math.round(t * 10) / 10, dewPointC: Math.round((t - 11 - z / 900) * 10) / 10, windDirectionDeg: r.dir, windSpeedMps: Math.round(r.kt * 0.514 * 10) / 10 });
    });
    return { validAt, levels: levels.filter((l) => l.pressureHpa >= 250) };
  };
  for (const site of sites.sites) {
    write(`raob/sites/${site.slug}.json`, {
      schemaVersion: 1,
      source: "Sample: the NWS Soaring Forecast table with a synthetic dew point",
      generatedAt: new Date(now).toISOString(),
      site: { slug: site.slug, name: site.name },
      station: { id: "KBOI", name: "Boise", latitude: 43.5677, longitude: -116.2109, distanceKm: 20, elevationM: 874 },
      soundings: [flight("2026-09-29T12:00:00Z", 0), flight("2026-09-29T00:00:00Z", 12)],
    });
  }
}
write(nwsPaths.manifest(), buildManifest({ now, sites: siteEntries, offices: [{ office: "BOI", afdIssuanceTime: new Date(now - 3 * HOUR).toISOString(), srgIssuanceTime: null }] }));

// ECMWF: synthetic Open-Meteo responses run through the real parser. A daily
// cycle: the boundary layer deepens to ~2 km by late afternoon, an afternoon
// north-westerly, cumulus building mid-afternoon.
{
  const start = Math.floor(now / HOUR) * HOUR - 6 * HOUR;
  const count = 8 * 24;
  const localHourOf = (t) => localHour(zone, t);
  const day = (t) => Math.max(0, Math.sin(((localHourOf(t) - 7) / 12) * Math.PI));
  const lateDay = (t) => Math.max(0, Math.sin(((localHourOf(t) - 9) / 12) * Math.PI));
  const values = {
    temperatureC: (t) => 8 + 14 * day(t),
    dewPointC: () => 1.5,
    windSpeedMps: (t) => 1.5 + 4.5 * lateDay(t),
    windDirectionDeg: (t) => (lateDay(t) > 0.3 ? 318 : 120),
    windGustMps: (t) => 3 + 7.5 * lateDay(t),
    cloudCoverPct: (t) => 15 + 45 * lateDay(t) ** 3,
    cloudLowPct: (t) => 5 + 35 * lateDay(t) ** 3,
    cloudMidPct: () => 10,
    cloudHighPct: (t) => 25 + 15 * Math.sin(t / (9 * HOUR)),
    precipitationMm: () => 0,
    capeJkg: (t) => 250 * lateDay(t) ** 2,
    boundaryLayerHeightM: (t) => 150 + 1900 * lateDay(t),
    shortwaveWm2: (t) => 780 * day(t),
    wind850SpeedMps: (t) => 5 + 3 * lateDay(t),
    wind850DirectionDeg: () => 300,
    height850M: () => 1525,
    wind700SpeedMps: () => 11,
    wind700DirectionDeg: () => 255,
    height700M: () => 3120,
  };
  const units = { "°C": "°C", "m/s": "m/s", "°": "°", "%": "%", mm: "mm", "J/kg": "J/kg", m: "m", "W/m²": "W/m²" };
  const response = (fields) => {
    const time = Array.from({ length: count }, (_, i) => (start + i * HOUR) / 1000);
    const hourly = { time };
    const hourly_units = { time: "unixtime" };
    for (const [field, [name, accepted]] of Object.entries(fields)) {
      hourly[name] = time.map((t) => values[field](t * 1000));
      hourly_units[name] = units[accepted[0]];
    }
    return { latitude: 43.62, longitude: -116.02, elevation: 1262, hourly_units, hourly };
  };
  const run = new Date(Math.floor((now - 7 * HOUR) / (6 * HOUR)) * 6 * HOUR).toISOString().replace(".000Z", "Z");
  for (const site of sites.sites) {
    const doc = buildEcmwfDocument({ site, surface: response(SURFACE_FIELDS), aloft: response(ALOFT_FIELDS), runs: { surface: run, aloft: run }, now });
    write(ecmwfPaths.site(site.slug), doc);
  }
  write(ecmwfPaths.manifest(), buildEcmwfManifest({ now, sites: sites.sites.map((s) => ({ slug: s.slug, ok: true })), runs: { surface: run, aloft: run } }));
}

// Sunlight map: synthetic foothills around each launch (a small square, so the
// sample builds in seconds). Ground rises to the south-east, so the launch faces
// north-west like Cervidae, with gullies and a higher ridge to the east.
for (const site of sites.sites) {
  const m = metresPerDegree(site.latitude);
  const elevation = (lat, lon) => {
    const e = (lon - site.longitude) * m.lon;
    const n = (lat - site.latitude) * m.lat;
    return (
      1268 +
      0.16 * (e - n) +
      70 * Math.sin(e / 430 + n / 650) * Math.cos(n / 520) +
      18 * Math.sin(e / 120) * Math.cos(n / 150) +
      380 * Math.exp(-(((e - 2600) / 700) ** 2))
    );
  };
  const radiusKm = 3;
  const maxDistanceKm = 6;
  const bounds = domainFor(site.latitude, site.longitude, radiusKm).bounds;
  const fine = gridFromFunction(elevation, { ...expandBounds(bounds, 100), dLon: 1 / 10800, dLat: 1 / 10800 });
  const coarse = gridFromFunction(elevation, { ...expandBounds(bounds, maxDistanceKm * 1000 + 500), dLon: 1 / 3600, dLat: 1 / 3600 });
  const sample = { id: "sample", name: "Synthetic sample terrain (not real)", resolutionM: 10, licence: "–", url: "" };
  const { index, tiles, relief } = buildSolarTerrain(site, { fine, coarse, radiusKm, maxDistanceKm, sources: { surface: sample, horizon: { ...sample, resolutionM: 30 } } });
  for (const tile of tiles) {
    const file = join(out, "solar", site.slug, index.tiles.path.replace("{z}", tile.z).replace("{x}", tile.x).replace("{y}", tile.y));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, tile.body);
  }
  writeFileSync(join(out, "solar", site.slug, index.relief.path), relief.body);
  write(`solar/${site.slug}/index.json`, index);
}

// Weather station: 13 hours of synthetic reports in Weather Underground's
// format (units=m), read by the same parser the Worker uses. Light downslope
// wind from the south-east overnight, turning up-slope from the north-west
// late morning and building with gusts; one 20-minute gap in the reports.
// Served in development at /api/stations/<id> (integrations/dev-data.mjs).
{
  const stations = readJson("../src/data/stations.json").stations;
  for (const [id, station] of Object.entries(stations)) {
    const site = sites.sites.find((s) => station.launches.includes(s.slug));
    if (!site) continue;
    const step = 5 * 60_000;
    const end = Math.floor(now / step) * step - 60_000;
    const rows = [];
    for (let t = end - 13 * HOUR; t <= end; t += step) {
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: site.timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(t)));
      const minute = new Date(t).getUTCMinutes();
      const local = hour + minute / 60;
      if (t > end - 3 * HOUR && t <= end - 2.6 * HOUR) continue; // the gap
      const upslope = local >= 11 && local <= 19;
      const build = upslope ? Math.min(1, (local - 11) / 3) : 0;
      const kmh = upslope ? 10 + 12 * build + 4 * Math.sin(t / 900_000) : 5 + 2 * Math.sin(t / 1_200_000);
      const sun = Math.max(0, 820 * Math.sin((Math.PI * (local - 7.2)) / 12)) * (0.85 + 0.15 * Math.cos(t / 1_700_000));
      const temp = 9 + 11 * Math.max(0, Math.sin((Math.PI * (local - 8)) / 14));
      rows.push({
        stationID: id,
        tz: site.timeZone,
        obsTimeUtc: new Date(t).toISOString().replace(".000Z", "Z"),
        epoch: Math.floor(t / 1000),
        lat: station.latitude,
        lon: station.longitude,
        solarRadiationHigh: Math.round(sun * 10) / 10,
        uvHigh: Math.round(sun / 100),
        winddirAvg: Math.round(upslope ? 315 + 20 * Math.sin(t / 2_000_000) : 125 + 15 * Math.sin(t / 2_500_000)),
        humidityAvg: Math.round(55 - temp * 1.2),
        qcStatus: 1,
        metric: {
          tempAvg: Math.round(temp * 10) / 10,
          dewptAvg: 0.8,
          windspeedAvg: Math.round(kmh * 10) / 10,
          windgustHigh: Math.round(kmh * (upslope ? 1.45 : 1.3) * 10) / 10,
          pressureMax: 1012.4,
          precipRate: 0,
          precipTotal: 0,
        },
      });
    }
    const last = rows.at(-1);
    const currentBody = {
      observations: [{
        stationID: id,
        obsTimeUtc: new Date(end + 60_000).toISOString().replace(".000Z", "Z"),
        lat: station.latitude,
        lon: station.longitude,
        solarRadiation: last.solarRadiationHigh,
        uv: last.uvHigh,
        winddir: last.winddirAvg,
        humidity: last.humidityAvg,
        qcStatus: 1,
        metric: { temp: last.metric.tempAvg, dewpt: 0.8, windSpeed: last.metric.windspeedAvg, windGust: last.metric.windgustHigh, pressure: 1012.2, precipRate: 0, precipTotal: 0 },
      }],
    };
    write(`api/stations/${id}.json`, {
      schemaVersion: STATION_SCHEMA,
      source: STATION_SOURCE,
      station: { id, name: `${station.name} (sample)`, latitude: station.latitude, longitude: station.longitude, elevationM: Math.round(station.elevationFt * 0.3048), url: dashboardUrl(id) },
      current: parseWuCurrent(currentBody),
      currentFetchedAt: new Date(now).toISOString(),
      history: parseWuHistory({ observations: rows }),
      historyFetchedAt: new Date(now).toISOString(),
    });
  }
}

console.log(`✓ Sample dataset for ${sites.sites.length} launch(es) written to ${out}`);
