// Shared access to the dataset bucket (Cloudflare R2 or any S3-compatible store).
//
// Uses the same variables and signing as the meteo engine: path-style URLs,
// SigV4 with region "auto", credentials from AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY, endpoint from METEO_S3_ENDPOINT (R2_ENDPOINT alias).

import { AwsClient } from "aws4fetch";

const REQUIRED = ["METEO_R2_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function bucketFromEnv(env = process.env) {
  const endpoint = env.METEO_S3_ENDPOINT ?? env.R2_ENDPOINT;
  const missing = REQUIRED.filter((name) => !env[name]);
  if (!endpoint) missing.unshift("METEO_S3_ENDPOINT");
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  if (env.METEO_DATA_BASE) {
    throw new Error("METEO_DATA_BASE is set: the engine would read the dataset over public HTTPS instead of the bucket. Unset it.");
  }

  const base = `${endpoint.replace(/\/+$/, "")}/${env.METEO_R2_BUCKET}`;
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  async function send(key, init) {
    const url = `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await client.fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
        if (!RETRYABLE.has(response.status)) return response;
        last = new Error(`${init.method} ${key} answered ${response.status}`);
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
    throw last;
  }

  return {
    name: env.METEO_R2_BUCKET,

    /** Uploads bytes; throws unless the store answers 200. */
    async put(key, body, { contentType = "application/json", cacheControl = "public, max-age=300" } = {}) {
      const response = await send(key, {
        method: "PUT",
        headers: { "content-type": contentType, "cache-control": cacheControl },
        body,
      });
      if (response.status !== 200) throw new Error(`PUT ${key} answered ${response.status}: ${await response.text()}`);
    },

    /** Returns the object's bytes, or null when the key does not exist. */
    async get(key) {
      const response = await send(key, { method: "GET" });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`GET ${key} answered ${response.status}: ${await response.text()}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
