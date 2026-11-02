// Validates sites.json before it reaches the bucket.
//
// 1. The engine's own strict parser (rejects unknown fields and elevationM,
//    exactly like `meteo forecast build`).
// 2. Operator rules the engine does not check: unique lowercase-hyphenated
//    slugs and a valid IANA time zone. Each launch's line lists the models
//    that cover it (scripts/lib/coverage.mjs) and whether the NWS does.
// 3. When the website is present, every launch has an entry in
//    web/src/data/launches.json and every entry there has a launch here.
// 4. sunlight-areas.json, next to sites.json: each area belongs to a launch,
//    contains it, and is not too large to build.
//
// Usage: node scripts/check-sites.mjs [path/to/sites.json]

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSites } from "@azohra/meteo.forecast";
import { areaErrors, areaSizeKm } from "./lib/sunlight-areas.mjs";
import { modelCovers, nwsCovers } from "./lib/coverage.mjs";

/** The models the workflows build (.github/workflows/build-data.yml). */
const MODELS = ["hrrr-conus", "hrdps-continental", "rrfs", "rdps", "gfs", "gdps", "geps"];

const path = resolve(process.argv[2] ?? "sites.json");
const text = readFileSync(path, "utf-8");

let sites;
try {
  sites = parseSites(text, path);
} catch (error) {
  console.error(`✗ ${path} fails the engine's site catalogue contract: ${error.message}`);
  process.exit(1);
}

const errors = [];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const seen = new Set();

for (const site of sites) {
  const label = `"${site.slug}"`;
  if (!SLUG.test(site.slug)) errors.push(`${label}: slug must be lowercase letters, digits and hyphens (e.g. cervidae-peak)`);
  if (seen.has(site.slug)) errors.push(`${label}: duplicate slug`);
  seen.add(site.slug);

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: site.timeZone });
  } catch {
    errors.push(`${label}: timeZone "${site.timeZone}" is not a valid IANA zone (e.g. America/Boise)`);
  }
}

const detailsPath = resolve(dirname(path), "../web/src/data/launches.json");
if (existsSync(detailsPath)) {
  const details = JSON.parse(readFileSync(detailsPath, "utf-8")).launches ?? {};
  for (const site of sites) {
    if (!(site.slug in details)) errors.push(`"${site.slug}": missing from web/src/data/launches.json (add its facing and wind limits)`);
  }
  for (const slug of Object.keys(details)) {
    if (!seen.has(slug)) errors.push(`"${slug}": in web/src/data/launches.json but not in sites.json`);
  }
}

const areasPath = resolve(dirname(path), "sunlight-areas.json");
const areas = existsSync(areasPath) ? JSON.parse(readFileSync(areasPath, "utf-8")) : { schemaVersion: 1, areas: {} };
for (const error of areaErrors(areas, sites)) errors.push(`sunlight-areas.json: ${error}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}

console.log(`✓ ${path}: ${sites.length} valid launch(es)`);
for (const site of sites) {
  console.log(`  - ${site.slug}  (${site.name})  ${site.latitude}, ${site.longitude}  ${site.timeZone}`);
  const models = MODELS.filter((model) => modelCovers(model, site));
  console.log(`      models: ${models.join(", ")}; NWS: ${nwsCovers(site.latitude, site.longitude) ? "yes" : "no (outside the US)"}`);
  const area = areas.areas?.[site.slug];
  if (area) {
    const size = areaSizeKm(area);
    console.log(`      sunlight map: ${area.name}, ${Math.round(size.eastWest)} x ${Math.round(size.northSouth)} km`);
  }
}
