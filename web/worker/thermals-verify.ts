// Pilot thermal reports for the /thermals map:
//   GET  /api/thermals/verifications?date=YYYY-MM-DD&hour=H[&device=ID]
//   POST /api/thermals/verify   body: { dateIso, hour, cellId, device }
//
// A pilot reports the cell where they found a thermal during an hour that has
// already passed (today or yesterday in America/Boise). Each report is its own
// R2 object, so concurrent reports never overwrite each other:
//
//   thermals/verifications/<date>/<hour>/<network>.<device>   customMetadata { cellId }
//
// <network> and <device> are HMAC-SHA256 digests keyed with the
// THERMALS_VOTE_SECRET secret and the date, so neither the visitor's IP nor
// their device ID is stored, and the same visitor cannot be linked across days.
// <device> is a random ID the page keeps in localStorage: pilots on the same
// mobile network often share an IP, so the IP alone would let only one of them
// report. A device reporting again for the same hour replaces its report, and
// one network may report at most MAX_REPORTS_PER_NETWORK times an hour.
// The Worker never serves these objects under /data.

export interface VoteObject {
  key: string;
  customMetadata?: Record<string, string>;
}

export interface VerificationBucket {
  put(key: string, value: string, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  list(options: {
    prefix: string;
    cursor?: string;
    include?: Array<"customMetadata">;
  }): Promise<{ objects: VoteObject[]; truncated: boolean; cursor?: string }>;
}

export interface VerifyOptions {
  now?: number;
  secret?: string;
}

const BOISE_TZ = "America/Boise";
const DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{16,64}$/;
const MIN_HOUR = 8;
const MAX_HOUR = 20;
const MIN_CELL_ID = 1;
const MAX_CELL_ID = 690;
export const MAX_REPORTS_PER_NETWORK = 10;
export const VERIFICATIONS_PREFIX = "thermals/verifications/";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function boiseDateAndHour(ms: number): { dateIso: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOISE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { dateIso: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

/** Whether pilots can report for this hour: it is yesterday, or today and has ended. */
export function isPastBoiseHour(dateIso: string, hour: number, nowMs = Date.now()): boolean {
  if (!DATE_ISO_RE.test(dateIso) || !Number.isInteger(hour) || hour < MIN_HOUR || hour > MAX_HOUR) return false;
  const today = boiseDateAndHour(nowMs);
  // Noon today minus a day is always yesterday's date, whatever the DST change.
  const noonUtcGuess = Date.parse(`${today.dateIso}T12:00:00Z`);
  const yesterday = boiseDateAndHour(noonUtcGuess - 24 * 3600_000).dateIso;
  if (dateIso === yesterday) return true;
  return dateIso === today.dateIso && hour < today.hour;
}

async function digest(secret: string, ...parts: string[]): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts.join("\n")));
  return [...new Uint8Array(mac).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const hourPrefix = (dateIso: string, hour: number) => `${VERIFICATIONS_PREFIX}${dateIso}/${hour}/`;

async function listHour(bucket: VerificationBucket, prefix: string): Promise<VoteObject[]> {
  const objects: VoteObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function summarize(objects: VoteObject[], prefix: string, deviceKey: string | null) {
  const countsByCell: Record<string, number> = {};
  let userVerifiedCellId: number | null = null;
  for (const object of objects) {
    const cell = object.customMetadata?.cellId;
    if (!cell) continue;
    countsByCell[cell] = (countsByCell[cell] ?? 0) + 1;
    if (deviceKey && object.key.slice(prefix.length).split(".")[1] === deviceKey) userVerifiedCellId = Number(cell);
  }
  return {
    countsByCell,
    totalVerifications: objects.length,
    userVerified: userVerifiedCellId !== null,
    userVerifiedCellId,
  };
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

export async function handleThermalVerifications(
  request: Request,
  bucket: VerificationBucket,
  options: VerifyOptions = {},
): Promise<Response> {
  const nowMs = options.now ?? Date.now();
  const url = new URL(request.url);
  const secret = options.secret ?? "";

  if (request.method === "GET" && url.pathname === "/api/thermals/verifications") {
    const dateIso = (url.searchParams.get("date") ?? "").trim();
    const hour = Number(url.searchParams.get("hour"));
    const device = url.searchParams.get("device") ?? "";
    if (!DATE_ISO_RE.test(dateIso) || !Number.isInteger(hour) || hour < MIN_HOUR || hour > MAX_HOUR) {
      return json(400, { error: "expected ?date=YYYY-MM-DD&hour=8..20" });
    }
    const prefix = hourPrefix(dateIso, hour);
    const deviceKey = secret && DEVICE_RE.test(device) ? await digest(secret, dateIso, "device", device) : null;
    return json(200, {
      dateIso,
      hour,
      isPastHour: isPastBoiseHour(dateIso, hour, nowMs),
      ...summarize(await listHour(bucket, prefix), prefix, deviceKey),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/thermals/verify") {
    if (!secret) return json(503, { error: "Thermal reports are not set up on this server." });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const dateIso = typeof body?.dateIso === "string" ? body.dateIso.trim() : "";
    const hour = Number(body?.hour);
    const cellId = Number(body?.cellId);
    const device = typeof body?.device === "string" ? body.device : "";

    if (!DATE_ISO_RE.test(dateIso)) return json(400, { error: "invalid dateIso (expected YYYY-MM-DD)" });
    if (!Number.isInteger(hour) || hour < MIN_HOUR || hour > MAX_HOUR) {
      return json(400, { error: `invalid hour (expected integer ${MIN_HOUR}..${MAX_HOUR})` });
    }
    if (!Number.isInteger(cellId) || cellId < MIN_CELL_ID || cellId > MAX_CELL_ID) {
      return json(400, { error: `invalid cellId (expected integer ${MIN_CELL_ID}..${MAX_CELL_ID})` });
    }
    if (!DEVICE_RE.test(device)) return json(400, { error: "invalid device id" });
    if (!isPastBoiseHour(dateIso, hour, nowMs)) {
      return json(400, { error: "Thermals can only be reported for hours that have already passed.", isPastHour: false });
    }

    const prefix = hourPrefix(dateIso, hour);
    const networkKey = await digest(secret, dateIso, "network", clientIp(request));
    const deviceKey = await digest(secret, dateIso, "device", device);
    const key = `${prefix}${networkKey}.${deviceKey}`;

    const fromNetwork = await listHour(bucket, `${prefix}${networkKey}.`);
    const isUpdate = fromNetwork.some((o) => o.key === key);
    if (!isUpdate && fromNetwork.length >= MAX_REPORTS_PER_NETWORK) {
      return json(429, { error: "Too many reports from this network for this hour." });
    }

    await bucket.put(key, "", { customMetadata: { cellId: String(cellId) } });
    const summary = summarize(await listHour(bucket, prefix), prefix, deviceKey);
    return json(200, { ok: true, dateIso, hour, cellId, ...summary });
  }

  return json(405, { error: "method not allowed" }, { allow: "GET, POST" });
}
