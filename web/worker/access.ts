// Verifies the Cloudflare Access token on admin requests.
//
// Cloudflare Access sits in front of /admin and /api/admin and signs every
// request it lets through with a JWT (Cf-Access-Jwt-Assertion header). The
// Worker checks that token itself as well, so the admin API stays closed even
// if the Access application is ever misconfigured or removed.

export interface AccessConfig {
  /** Zero Trust team domain, e.g. "myteam.cloudflareaccess.com". */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience: string;
  /** Optional extra allowlist of emails (lowercase), on top of the Access policy. */
  allowedEmails?: string[];
}

export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const keyCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const KEY_TTL_MS = 60 * 60 * 1000;

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

async function signingKeys(teamDomain: string, fetchImpl: FetchLike, now: number, refresh: boolean): Promise<Jwk[]> {
  const cached = keyCache.get(teamDomain);
  if (cached && !refresh && now - cached.fetchedAt < KEY_TTL_MS) return cached.keys;
  const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new AccessError(503, `could not load Access signing keys (${response.status})`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  keyCache.set(teamDomain, { keys, fetchedAt: now });
  return keys;
}

/** Returns the signed-in email, or throws AccessError (401/403/503). */
export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  { fetchImpl = fetch as unknown as FetchLike, now = Date.now() }: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<string> {
  if (!token) throw new AccessError(401, "not signed in");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError(401, "malformed token");
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(headerPart);
    payload = decodeJson(payloadPart);
  } catch {
    throw new AccessError(401, "malformed token");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessError(401, "unsupported token");

  let jwk = (await signingKeys(config.teamDomain, fetchImpl, now, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(config.teamDomain, fetchImpl, now, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessError(401, "unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new AccessError(401, "invalid signature");

  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) throw new AccessError(401, "token is for another application");
  if (payload.iss !== `https://${config.teamDomain}`) throw new AccessError(401, "token from another issuer");
  if (typeof payload.exp !== "number" || payload.exp < seconds) throw new AccessError(401, "token expired");
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) throw new AccessError(401, "token not yet valid");

  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email) throw new AccessError(403, "token has no email");
  if (config.allowedEmails && config.allowedEmails.length > 0 && !config.allowedEmails.includes(email)) {
    throw new AccessError(403, "this account is not an admin");
  }
  return email;
}
