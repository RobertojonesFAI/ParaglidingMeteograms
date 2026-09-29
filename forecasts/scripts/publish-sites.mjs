// Publishes sites.json to the root of the dataset bucket.
//
// The engine never writes sites.json: it is the one root file the operator
// uploads, unchanged. This script validates it, uploads it with the same S3
// signing the engine uses (aws4fetch, region "auto" for R2), and reads it
// back to confirm the bytes match.
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
import { AwsClient } from "aws4fetch";
import { parseSites } from "@azohra/meteo.forecast";

const required = ["METEO_S3_ENDPOINT", "METEO_R2_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`✗ Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
if (process.env.METEO_DATA_BASE) {
  console.error("✗ METEO_DATA_BASE is set: the engine would read the dataset over public HTTPS instead of the bucket. Unset it.");
  process.exit(1);
}

const path = resolve(process.argv[2] ?? "sites.json");
const bytes = readFileSync(path);
const sites = parseSites(bytes.toString("utf-8"), path); // throws on an invalid catalogue

const endpoint = process.env.METEO_S3_ENDPOINT.replace(/\/+$/, "");
const url = `${endpoint}/${process.env.METEO_R2_BUCKET}/sites.json`;
const client = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});

const put = await client.fetch(url, {
  method: "PUT",
  headers: {
    "content-type": "application/json",
    "cache-control": "public, max-age=300",
  },
  body: bytes,
});
if (put.status !== 200) {
  console.error(`✗ PUT sites.json answered ${put.status}: ${await put.text()}`);
  process.exit(1);
}

const get = await client.fetch(url, { method: "GET" });
const echoed = Buffer.from(await get.arrayBuffer());
if (get.status !== 200 || !echoed.equals(bytes)) {
  console.error(`✗ Read-back of sites.json does not match what was uploaded (status ${get.status})`);
  process.exit(1);
}

console.log(`✓ Published sites.json to s3://${process.env.METEO_R2_BUCKET}/sites.json (${sites.length} launch(es))`);
