import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessError, verifyAccessJwt } from "../worker/access.ts";

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = Date.parse("2026-09-29T20:00:00Z");

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? Buffer.from(bytes) : bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const other = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const certs = { keys: [jwk] };

async function token(payload: Record<string, unknown>, { kid = "k1", key = pair.privateKey } = {}) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

const good = { aud: [AUD], iss: `https://${TEAM}`, email: "Pilot@Example.com", exp: NOW / 1000 + 600, iat: NOW / 1000 - 10 };
let fetches = 0;
const fetchImpl = async (url: string) => {
  fetches += 1;
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return { ok: true, status: 200, json: async () => certs };
};
const config = { teamDomain: TEAM, audience: AUD };

async function rejects(promise: Promise<unknown>, status: number, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AccessError);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

test("accepts a valid Access token and returns the lowercased email", async () => {
  assert.equal(await verifyAccessJwt(await token(good), config, { fetchImpl, now: NOW }), "pilot@example.com");
});

test("caches the signing keys between requests", async () => {
  const before = fetches;
  await verifyAccessJwt(await token(good), config, { fetchImpl, now: NOW });
  await verifyAccessJwt(await token(good), config, { fetchImpl, now: NOW });
  assert.equal(fetches, before);
});

test("rejects missing, forged, expired and foreign tokens", async () => {
  await rejects(verifyAccessJwt(null, config, { fetchImpl, now: NOW }), 401, /not signed in/);
  await rejects(verifyAccessJwt("a.b", config, { fetchImpl, now: NOW }), 401, /malformed/);
  await rejects(verifyAccessJwt(await token(good, { key: other.privateKey }), config, { fetchImpl, now: NOW }), 401, /invalid signature/);
  await rejects(verifyAccessJwt(await token({ ...good, exp: NOW / 1000 - 1 }), config, { fetchImpl, now: NOW }), 401, /expired/);
  await rejects(verifyAccessJwt(await token({ ...good, aud: ["someone-else"] }), config, { fetchImpl, now: NOW }), 401, /another application/);
  await rejects(verifyAccessJwt(await token({ ...good, iss: "https://evil.example" }), config, { fetchImpl, now: NOW }), 401, /another issuer/);
  await rejects(verifyAccessJwt(await token(good, { kid: "unknown" }), config, { fetchImpl, now: NOW }), 401, /unknown signing key/);
});

test("the optional email allowlist narrows who is an admin", async () => {
  const t = await token(good);
  assert.equal(await verifyAccessJwt(t, { ...config, allowedEmails: ["pilot@example.com"] }, { fetchImpl, now: NOW }), "pilot@example.com");
  await rejects(verifyAccessJwt(t, { ...config, allowedEmails: ["other@example.com"] }, { fetchImpl, now: NOW }), 403, /not an admin/);
});
