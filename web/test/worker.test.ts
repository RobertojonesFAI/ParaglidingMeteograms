import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../worker/index.ts";

/** In-memory stand-in for the R2 binding: honours If-None-Match like R2's onlyIf. */
function fakeBucket(objects: Record<string, { body: string; contentType: string; cacheControl?: string }>) {
  const requested: string[] = [];
  return {
    requested,
    async get(key: string, options?: { onlyIf?: Headers }) {
      requested.push(key);
      const object = objects[key];
      if (!object) return null;
      const etag = `"${key.length}"`;
      const writeHttpMetadata = (headers: Headers) => {
        headers.set("content-type", object.contentType);
        if (object.cacheControl) headers.set("cache-control", object.cacheControl);
      };
      if (options?.onlyIf?.get("if-none-match") === etag) return { httpEtag: etag, writeHttpMetadata };
      return { httpEtag: etag, writeHttpMetadata, body: new Response(object.body).body! };
    },
  };
}

function env(bucket = fakeBucket({}), extra: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("static page", { status: 200 }) },
    DATA: bucket as unknown as Env["DATA"],
    ...extra,
  };
}

const request = (path: string, init?: RequestInit) => new Request(`https://example.com${path}`, init);

test("serves dataset documents from the bucket with their metadata", async () => {
  const bucket = fakeBucket({
    "hrrr-conus/sites/cervidae-peak.json": { body: '{"ok":true}', contentType: "application/json", cacheControl: "public, max-age=300" },
  });
  const response = await worker.fetch(request("/data/hrrr-conus/sites/cervidae-peak.json"), env(bucket));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), { ok: true });
});

test("answers 304 when the client already has the object", async () => {
  const bucket = fakeBucket({ "runs.json": { body: "{}", contentType: "application/json" } });
  const response = await worker.fetch(request("/data/runs.json", { headers: { "if-none-match": '"9"' } }), env(bucket));
  assert.equal(response.status, 304);
  assert.equal(response.body, null);
});

test("rejects keys outside the dataset shape without touching the bucket", async () => {
  const bucket = fakeBucket({});
  // "/data/../x" is normalized away by URL parsing before the Worker sees it; the
  // encoded forms below do reach it and must still be refused.
  for (const path of ["/data/gfs%2F..%2Fsecret.json", "/data/.env", "/data/notes.txt", "/data/", "/data/a//b.json", "/data/%2Fetc%2Fpasswd.json"]) {
    const response = await worker.fetch(request(path), env(bucket));
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(bucket.requested, []);
  const normalized = await worker.fetch(request("/data/../secret.json"), env(bucket));
  assert.equal(await normalized.text(), "static page");
  assert.deepEqual(bucket.requested, []);
  const missing = await worker.fetch(request("/data/gfs/manifest.json"), env(bucket));
  assert.equal(missing.status, 404);
  const post = await worker.fetch(request("/data/runs.json", { method: "POST" }), env(bucket));
  assert.equal(post.status, 405);
});

test("admin API stays closed until it is configured, and without a login", async () => {
  const unconfigured = await worker.fetch(request("/api/admin/launches"), env());
  assert.equal(unconfigured.status, 503);
  const configured = env(fakeBucket({}), {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    GITHUB_TOKEN: "t",
    GITHUB_REPO: "owner/repo",
  });
  const anonymous = await worker.fetch(request("/api/admin/launches"), configured);
  assert.equal(anonymous.status, 401);
});

test("other paths fall through to the static site; unknown API paths are 404", async () => {
  assert.equal(await (await worker.fetch(request("/launches/cervidae-peak"), env())).text(), "static page");
  assert.equal((await worker.fetch(request("/api/other"), env())).status, 404);
});
