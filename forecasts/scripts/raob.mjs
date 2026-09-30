// Fetches the latest weather-balloon soundings for each launch's nearest
// upper-air station and, optionally, publishes them to the dataset bucket.
//
//   raob/sites/<slug>.json   the station's two latest soundings
//
// Usage:
//   node scripts/raob.mjs [--sites sites.json] [--output data] [--publish] [--notice]
//
// A launch with no station within 300 km is skipped. --notice prints a one-line
// summary per station as a GitHub Actions notice (used by the Check workflow).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseSites } from "@azohra/meteo.forecast";
import { bucketFromEnv } from "./lib/bucket.mjs";
import { buildSiteDocument, createClient, fetchStationSoundings, nearestStation, paths } from "./lib/raob.mjs";

const { values: args } = parseArgs({
  options: {
    sites: { type: "string", default: "sites.json" },
    output: { type: "string", default: "data" },
    publish: { type: "boolean", default: false },
    notice: { type: "boolean", default: false },
  },
});

const bucket = args.publish ? bucketFromEnv() : null;
const sitesPath = resolve(args.sites);
const sites = parseSites(readFileSync(sitesPath, "utf-8"), sitesPath);
const getJson = createClient();
const now = Date.now();
const warn = (message) => console.warn(`WARN ${message}`);

const byStation = new Map();
for (const site of sites) {
  const station = nearestStation(site);
  if (!station) {
    console.log(`– ${site.slug}: no upper-air station within 300 km`);
    continue;
  }
  if (!byStation.has(station.id)) byStation.set(station.id, { station, sites: [] });
  byStation.get(station.id).sites.push({ site, station });
}

let failed = 0;
for (const { station, sites: stationSites } of byStation.values()) {
  const tried = [];
  const soundings = await fetchStationSoundings(station, getJson, { now, warn, log: (m) => (console.log(m), tried.push(m)) });
  if (soundings.length === 0) {
    failed += 1;
    console.error(`✗ ${station.id}: no sounding found in the last 48 hours`);
    continue;
  }
  const summary = soundings.map((s) => `${s.validAt} ${s.levels.length} levels (${s.levels[0].heightM} m, ${s.levels[0].temperatureC}/${s.levels[0].dewPointC} °C, top ${s.levels.at(-1).pressureHpa} hPa)`).join("; ");
  console.log(`✓ ${station.id}: ${summary}`);
  if (args.notice) {
    const first = soundings[0].levels;
    const withDew = first.filter((l) => l.dewPointC !== null).length;
    const withWind = first.filter((l) => l.windSpeedMps !== null).length;
    console.log(`::notice title=${station.id} balloon::${summary}; dew point on ${withDew}, wind on ${withWind} levels. Tried: ${tried.join(" | ")}`);
  }
  for (const { site, station: withDistance } of stationSites) {
    const doc = buildSiteDocument({ site, station: withDistance, soundings, now });
    const bytes = Buffer.from(`${JSON.stringify(doc)}\n`);
    const key = paths.site(site.slug);
    const file = join(resolve(args.output), key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    if (bucket) await bucket.put(key, bytes);
  }
}
if (bucket) console.log(`✓ Published balloon soundings for ${sites.length} launch(es)`);
if (failed > 0) process.exit(1);
