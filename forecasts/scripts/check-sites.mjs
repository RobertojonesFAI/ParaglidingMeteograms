// Validates sites.json before it reaches the bucket.
//
// 1. The engine's own strict parser (rejects unknown fields and elevationM,
//    exactly like `meteo forecast build`).
// 2. Operator rules the engine does not check: unique lowercase-hyphenated
//    slugs, a valid IANA time zone, and a warning when a launch falls outside
//    HRRR/RRFS coverage (the contiguous US).
//
// Usage: node scripts/check-sites.mjs [path/to/sites.json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSites } from "@azohra/meteo.forecast";

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
const warnings = [];
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

  // Rough contiguous-US box; HRRR and RRFS do not cover launches outside it.
  const inConus = site.latitude >= 24 && site.latitude <= 50 && site.longitude >= -125 && site.longitude <= -66;
  if (!inConus) warnings.push(`${label}: outside the contiguous US; HRRR and RRFS probably do not cover it`);
}

for (const warning of warnings) console.warn(`⚠ ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}

console.log(`✓ ${path}: ${sites.length} valid launch(es)`);
for (const site of sites) {
  console.log(`  - ${site.slug}  (${site.name})  ${site.latitude}, ${site.longitude}  ${site.timeZone}`);
}
