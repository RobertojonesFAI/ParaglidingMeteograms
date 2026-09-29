// Publishes sites.json to the root of the dataset bucket.
//
// The engine never writes sites.json: it is the one root file the operator
// uploads, unchanged. This script validates it, uploads it, and reads it back
// to confirm the bytes match.
//
// Required environment (the same variables the engine reads):
//   METEO_S3_ENDPOINT      https://<account-id>.r2.cloudflarestorage.com
//   METEO_R2_BUCKET        bucket name
//   AWS_ACCESS_KEY_ID      R2 API token access key
//   AWS_SECRET_ACCESS_KEY  R2 API token secret
//
// Usage: node scripts/publish-sites.mjs [path/to/sites.json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSites } from "@azohra/meteo.forecast";
import { bucketFromEnv } from "./lib/bucket.mjs";

let bucket;
try {
  bucket = bucketFromEnv();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const path = resolve(process.argv[2] ?? "sites.json");
const bytes = readFileSync(path);
const sites = parseSites(bytes.toString("utf-8"), path); // throws on an invalid catalogue

await bucket.put("sites.json", bytes);
const echoed = await bucket.get("sites.json");
if (echoed === null || !echoed.equals(bytes)) {
  console.error("✗ Read-back of sites.json does not match what was uploaded");
  process.exit(1);
}

console.log(`✓ Published sites.json to s3://${bucket.name}/sites.json (${sites.length} launch(es))`);
