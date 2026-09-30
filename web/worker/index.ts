// The site's Worker. Static pages are served from the Astro build (ASSETS);
// the Worker itself only runs for the routes listed in wrangler.jsonc
// (`run_worker_first`):
//
//   GET /data/<key>          the published forecast dataset, read from the R2
//                            bucket binding (the bucket itself stays private)
//   /api/admin/launches      list (GET) and create/update (POST) launches;
//                            requires a valid Cloudflare Access login

import { AccessError, verifyAccessJwt } from "./access.ts";
import { GitHubError, listLaunches, saveLaunch } from "./github.ts";
import { validateLaunchInput } from "../src/lib/launches.ts";

interface R2ObjectLike {
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
  body?: ReadableStream;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DATA: { get(key: string, options?: { onlyIf?: Headers }): Promise<R2ObjectLike | null> };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
}

// JSON documents, gzipped history lines, and the sunlight map's binary tiles.
const DATA_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:json|jsonl\.gz|bin\.gz)$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function serveData(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" }, { allow: "GET, HEAD" });
  if (!DATA_KEY.test(key) || key.includes("..")) return json(404, { error: "not found" });

  const object = await env.DATA.get(key, { onlyIf: request.headers });
  if (object === null) return json(404, { error: "not found" }, { "cache-control": "public, max-age=60" });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=300");
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");

  // A conditional request that matched returns metadata without a body.
  if (!object.body) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function admin(request: Request, env: Env): Promise<Response> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return json(503, { error: "admin login is not configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD)" });
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json(503, { error: "saving is not configured (GITHUB_TOKEN, GITHUB_REPO)" });

  let email: string;
  try {
    email = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      allowedEmails: (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    });
  } catch (error) {
    if (error instanceof AccessError) return json(error.status, { error: error.message });
    throw error;
  }

  const github = { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || "main" };
  try {
    if (request.method === "GET") {
      const { launches, headSha } = await listLaunches(github, fetch);
      return json(200, { email, headSha, launches });
    }
    if (request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { mode?: unknown; launch?: unknown } | null;
      const mode = body?.mode === "update" ? "update" : body?.mode === "create" ? "create" : null;
      if (!mode || typeof body?.launch !== "object" || body.launch === null) return json(400, { error: "expected { mode, launch }" });
      const result = validateLaunchInput(body.launch as Record<string, unknown>);
      if ("errors" in result) return json(422, { error: "invalid launch", details: result.errors });
      const saved = await saveLaunch(github, fetch, result.launch, mode);
      return json(200, { launch: result.launch, ...saved });
    }
    return json(405, { error: "method not allowed" }, { allow: "GET, POST" });
  } catch (error) {
    if (error instanceof GitHubError) {
      const status = error.status === 409 ? 409 : 502;
      return json(status, { error: status === 409 ? error.message : "GitHub request failed", details: [error.message] });
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/data/")) return serveData(request, env, decodeURIComponent(url.pathname.slice("/data/".length)));
    if (url.pathname === "/api/admin/launches") return admin(request, env);
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    return env.ASSETS.fetch(request);
  },
};
