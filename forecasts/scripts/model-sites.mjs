// Writes the site catalogue one model is built from: the launches inside its
// grid (scripts/lib/coverage.mjs). The engine fails a whole model build when
// one launch lies outside the grid, so HRRR must never see a launch in Mexico.
//
// Reads the published sites.json from the dataset bucket (the same catalogue
// `--sites dataset` would read), or a local file with --sites. Prints how many
// launches the model covers; with none, writes nothing and prints "0".
//
// Usage:
//   node scripts/model-sites.mjs --model hrrr-conus --output /tmp/hrrr-sites.json
//   node scripts/model-sites.mjs --model hrrr-conus --sites sites.json --output data/hrrr-sites.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SITES_SCHEMA_VERSION, parseSites } from "@azohra/meteo.forecast";
import { bucketFromEnv } from "./lib/bucket.mjs";
import { sitesForModel } from "./lib/coverage.mjs";

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    sites: { type: "string" },
    output: { type: "string" },
  },
});
if (!args.model || !args.output) {
  console.error("usage: node scripts/model-sites.mjs --model SLUG [--sites PATH] --output PATH");
  process.exit(2);
}

let text;
if (args.sites) {
  text = readFileSync(resolve(args.sites), "utf-8");
} else {
  const bytes = await bucketFromEnv().get("sites.json");
  if (bytes === null) {
    console.error("✗ no sites.json is published at the dataset root");
    process.exit(1);
  }
  text = bytes.toString("utf-8");
}

const sites = parseSites(text, args.sites ?? "published sites.json");
const { covered, skipped } = sitesForModel(args.model, sites);
for (const site of skipped) console.error(`– ${args.model}: ${site.slug} is outside the model's grid, not built`);

if (covered.length > 0) {
  const output = resolve(args.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ schemaVersion: SITES_SCHEMA_VERSION, sites: covered }, null, 2)}\n`);
}
console.log(covered.length);
