// Fetches the National Weather Service forecast for every launch and,
// optionally, publishes it to the dataset bucket.
//
//   nws/sites/<slug>.json   hourly grid forecast + text periods for one launch
//   nws/offices/<id>.json   latest Area Forecast Discussion (and Soaring Forecast, if issued)
//   nws/manifest.json       what was published this run (uploaded last)
//
// Usage:
//   node scripts/nws.mjs [--sites sites.json] [--output data] [--publish]
//
// Without --publish nothing leaves the machine: the documents are written
// under --output only. NWS_USER_AGENT overrides the default User-Agent.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseSites } from "@azohra/meteo.forecast";
import { bucketFromEnv } from "./lib/bucket.mjs";
import {
  DEFAULT_USER_AGENT,
  buildManifest,
  createClient,
  fetchOfficeDocument,
  fetchSiteDocument,
  paths,
} from "./lib/nws.mjs";

const { values: args } = parseArgs({
  options: {
    sites: { type: "string", default: "sites.json" },
    output: { type: "string", default: "data" },
    publish: { type: "boolean", default: false },
  },
});

const bucket = args.publish ? bucketFromEnv() : null;
const sitesPath = resolve(args.sites);
const sites = parseSites(readFileSync(sitesPath, "utf-8"), sitesPath);
const getJson = createClient({ userAgent: process.env.NWS_USER_AGENT || DEFAULT_USER_AGENT });
const now = Date.now();
// "WARN " lines become warning annotations in GitHub Actions (scripts/run-annotated.sh).
const warn = (message) => console.warn(`WARN ${message}`);

const written = []; // [key, bytes] in upload order
function write(key, document) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 1)}\n`);
  const file = join(resolve(args.output), key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  written.push([key, bytes]);
}

const siteEntries = [];
const documents = [];
for (const site of sites) {
  try {
    const document = await fetchSiteDocument(site, getJson, { now, warn });
    write(paths.site(site.slug), document);
    documents.push(document);
    siteEntries.push({ slug: site.slug, ok: true, office: document.grid.office, updateTime: document.updateTime });
    console.log(`✓ ${site.slug}: ${document.grid.office} ${document.grid.x},${document.grid.y}, ${document.hours.length} h, updated ${document.updateTime}`);
  } catch (error) {
    siteEntries.push({ slug: site.slug, ok: false, error: error.message });
    console.error(`✗ ${site.slug}: ${error.message}`);
  }
}

const officeEntries = [];
const offices = [...new Set(documents.map((d) => d.grid.office))].sort();
for (const office of offices) {
  const document = await fetchOfficeDocument(office, getJson, { now, warn });
  write(paths.office(office), document);
  officeEntries.push({
    office,
    afdIssuanceTime: document.products.afd?.issuanceTime ?? null,
    srgIssuanceTime: document.products.srg?.issuanceTime ?? null,
  });
  console.log(`✓ ${office}: AFD ${document.products.afd ? "yes" : "no"}, Soaring Forecast ${document.products.srg ? "yes" : "no"}`);
}

if (documents.length > 0) {
  write(paths.manifest(), buildManifest({ now, sites: siteEntries, offices: officeEntries }));
}

if (bucket && written.length > 0) {
  // Manifest last: it is the commit point, so nothing it references appears after it.
  for (const [key, bytes] of written) await bucket.put(key, bytes);
  console.log(`✓ Published ${written.length} object(s) to s3://${bucket.name}/nws/`);
}

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(documents, officeEntries));

const failed = siteEntries.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`✗ ${failed.length} launch(es) failed: ${failed.map((f) => f.slug).join(", ")}`);
  process.exit(1);
}

// ── job summary (for people reading the Actions run) ─────────────────────

function summary(docs, officeRows) {
  const compass = (deg) =>
    deg == null ? "" : ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16];
  const mph = (mps) => (mps == null ? "" : Math.round(mps * 2.23694));
  const ft = (m) => (m == null ? "" : Math.round((m * 3.28084) / 100) * 100);
  const pct = (v) => (v == null ? "" : `${v}%`);

  let out = "## NWS forecast\n\n";
  for (const doc of docs) {
    const local = new Intl.DateTimeFormat("en-US", { timeZone: doc.site.timeZone, weekday: "short", hour: "numeric" });
    out += `### ${doc.site.name}\n\n`;
    out += `Grid ${doc.grid.office} ${doc.grid.x},${doc.grid.y} (grid elevation ${ft(doc.grid.elevationM)} ft), updated ${doc.updateTime}. [forecast.weather.gov](${doc.pageUrl})\n\n`;
    out += "| Local time | Wind (mph) | Gust | Sky | Mixing height (ft AGL) | Transport wind (mph) | Thunder | Forecast |\n";
    out += "| --- | --- | --- | --- | --- | --- | --- | --- |\n";
    for (const h of doc.hours.slice(0, 12)) {
      out += `| ${local.format(new Date(h.validAt))} | ${compass(h.windDirectionDeg)} ${mph(h.windSpeedMps)} | ${mph(h.windGustMps)} | ${pct(h.skyCoverPct)} | ${ft(h.mixingHeightM)} | ${compass(h.transportWindDirectionDeg)} ${mph(h.transportWindSpeedMps)} | ${pct(h.thunderProbabilityPct)} | ${h.shortForecast ?? ""} |\n`;
    }
    out += "\n";
  }
  for (const row of officeRows) {
    out += `Office ${row.office}: Area Forecast Discussion ${row.afdIssuanceTime ?? "not found"}; Soaring Forecast ${row.srgIssuanceTime ?? "not issued"}.\n\n`;
  }
  return out;
}
