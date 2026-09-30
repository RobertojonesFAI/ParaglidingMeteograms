// Fetches the ECMWF IFS forecast for every launch from Open-Meteo and,
// optionally, publishes it to the dataset bucket.
//
//   ecmwf/sites/<slug>.json   hourly surface wind, gusts, boundary-layer height,
//                             cloud layers, winds at 850 and 700 hPa
//   ecmwf/manifest.json       what was published this run (uploaded last)
//
// Usage:
//   node scripts/ecmwf.mjs [--sites sites.json] [--output data] [--publish] [--notice]
//
// Without --publish nothing leaves the machine. --notice prints a one-line
// summary per launch as a GitHub Actions notice (used by the Check workflow).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseSites } from "@azohra/meteo.forecast";
import { bucketFromEnv } from "./lib/bucket.mjs";
import { buildManifest, createClient, fetchSiteDocument, paths } from "./lib/ecmwf.mjs";

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
// "WARN " lines become warning annotations in GitHub Actions (scripts/run-annotated.sh).
const warn = (message) => console.warn(`WARN ${message}`);

const written = [];
function write(key, document) {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  const file = join(resolve(args.output), key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  written.push([key, bytes]);
}

const entries = [];
const documents = [];
for (const site of sites) {
  try {
    const doc = await fetchSiteDocument(site, getJson, { now, warn });
    write(paths.site(site.slug), doc);
    documents.push(doc);
    entries.push({ slug: site.slug, ok: true, hours: doc.hours.length });
    console.log(`✓ ${site.slug}: ${doc.hours.length} h, run ${doc.models.surface.run ?? "unknown"} (aloft ${doc.models.aloft.run ?? "unknown"}), grid ${doc.site.gridLatitude},${doc.site.gridLongitude} at ${doc.site.gridElevationM} m`);
    if (args.notice) {
      const filled = (field) => doc.hours.filter((h) => h[field] !== null).length;
      const fields = Object.keys(doc.units).map((f) => `${f} ${filled(f)}`).join(", ");
      const first = doc.hours.slice(0, 24).filter((h) => h.boundaryLayerHeightM !== null);
      const peak = first.reduce((m, h) => Math.max(m, h.boundaryLayerHeightM), 0);
      console.log(`::notice title=${site.slug} ECMWF::${doc.hours.length} h from ${doc.hours[0].validAt} to ${doc.hours.at(-1).validAt}; runs ${doc.models.surface.run} / ${doc.models.aloft.run}; grid ${doc.site.gridLatitude},${doc.site.gridLongitude} ${doc.site.gridElevationM} m; peak BLH next 24 h ${peak} m; filled: ${fields}`);
    }
  } catch (error) {
    entries.push({ slug: site.slug, ok: false, error: error.message });
    console.error(`✗ ${site.slug}: ${error.message}`);
  }
}

if (documents.length > 0) {
  const runs = { surface: documents[0].models.surface.run, aloft: documents[0].models.aloft.run };
  write(paths.manifest(), buildManifest({ now, sites: entries, runs }));
}

if (bucket && written.length > 0) {
  // Manifest last: it is the commit point.
  for (const [key, bytes] of written) await bucket.put(key, bytes);
  console.log(`✓ Published ${written.length} object(s) to s3://${bucket.name}/ecmwf/`);
}

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(documents));

const failed = entries.filter((e) => !e.ok);
if (failed.length > 0) {
  console.error(`✗ ${failed.length} launch(es) failed: ${failed.map((f) => f.slug).join(", ")}`);
  process.exit(1);
}

function summary(docs) {
  const compass = (deg) =>
    deg == null ? "" : ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16];
  const mph = (mps) => (mps == null ? "" : Math.round(mps * 2.23694));
  const ft = (m) => (m == null ? "" : Math.round((m * 3.28084) / 100) * 100);
  const pct = (v) => (v == null ? "" : `${v}%`);
  let out = "## ECMWF forecast\n\n";
  for (const doc of docs) {
    const local = new Intl.DateTimeFormat("en-US", { timeZone: doc.site.timeZone, weekday: "short", hour: "numeric" });
    out += `### ${doc.site.name}\n\nIFS 9 km run ${doc.models.surface.run ?? "unknown"}; winds aloft from IFS 0.25° run ${doc.models.aloft.run ?? "unknown"}.\n\n`;
    out += "| Local time | Wind (mph) | Gust | 850 hPa wind | BL height (ft AGL) | Low / mid / high cloud |\n| --- | --- | --- | --- | --- | --- |\n";
    for (const h of doc.hours.slice(0, 12)) {
      out += `| ${local.format(new Date(h.validAt))} | ${compass(h.windDirectionDeg)} ${mph(h.windSpeedMps)} | ${mph(h.windGustMps)} | ${compass(h.wind850DirectionDeg)} ${mph(h.wind850SpeedMps)} | ${ft(h.boundaryLayerHeightM)} | ${pct(h.cloudLowPct)} / ${pct(h.cloudMidPct)} / ${pct(h.cloudHighPct)} |\n`;
    }
    out += "\n";
  }
  return out;
}
