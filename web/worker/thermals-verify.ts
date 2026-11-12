// Thermal verification endpoints for /thermals:
//   GET  /api/thermals/verifications?date=YYYY-MM-DD&hour=H
//   POST /api/thermals/verify   body: { dateIso, hour, cellId }
//
// Stores per-day verification logs in R2 at `thermals/verifications/<YYYY-MM-DD>.json`.
// Each entry records { cellId, ip, timestamp }. Only hours that have already
// passed in America/Boise are accepted, and each IP may verify at most once per
// (dateIso, hour). Public GET responses return aggregated cell counts and whether
// the requesting IP has already verified that hour, without exposing visitor IPs.

export interface VerificationBucket {
  get(key: string): Promise<{ text?(): Promise<string>; body?: ReadableStream } | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<unknown>;
}

export interface ThermalVerificationEntry {
  cellId: number;
  ip: string;
  timestamp: string;
}

export interface HourVerificationRecord {
  entries: ThermalVerificationEntry[];
  countsByCell: Record<string, number>;
}

export interface DayVerificationDocument {
  schemaVersion: 1;
  dateIso: string;
  hours: Record<string, HourVerificationRecord>;
}

const BOISE_TZ = "America/Boise";
const DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_HOUR = 8;
const MAX_HOUR = 20;
const MIN_CELL_ID = 1;
const MAX_CELL_ID = 690;

export const verificationKey = (dateIso: string) => `thermals/verifications/${dateIso}.json`;

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

function formatBoiseDateAndHour(ms: number): { dateIso: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOISE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dateIso = `${get("year")}-${get("month")}-${get("day")}`;
  const rawHour = Number(get("hour"));
  const hour = rawHour === 24 ? 0 : rawHour;
  return { dateIso, hour };
}

export function getBoiseClock(nowMs = Date.now()): {
  todayIso: string;
  yesterdayIso: string;
  currentHour: number;
} {
  const today = formatBoiseDateAndHour(nowMs);
  // Step back 24h (and if DST shifted, noon-to-noon safe check)
  const yesterday = formatBoiseDateAndHour(nowMs - 24 * 3600_000);
  return {
    todayIso: today.dateIso,
    yesterdayIso: yesterday.dateIso,
    currentHour: today.hour,
  };
}

export function isPastBoiseHour(dateIso: string, hour: number, nowMs = Date.now()): boolean {
  if (!DATE_ISO_RE.test(dateIso)) return false;
  if (!Number.isInteger(hour) || hour < MIN_HOUR || hour > MAX_HOUR) return false;

  const clock = getBoiseClock(nowMs);
  if (dateIso === clock.yesterdayIso) {
    return true;
  }
  if (dateIso === clock.todayIso) {
    return hour < clock.currentHour;
  }
  return false;
}

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return "127.0.0.1";
}

async function readDayDocument(bucket: VerificationBucket, dateIso: string): Promise<DayVerificationDocument> {
  const obj = await bucket.get(verificationKey(dateIso));
  if (obj) {
    try {
      const raw = obj.text ? await obj.text() : obj.body ? await new Response(obj.body).text() : "";
      if (raw) {
        const parsed = JSON.parse(raw) as DayVerificationDocument;
        if (parsed && typeof parsed === "object" && parsed.hours && typeof parsed.hours === "object") {
          return parsed;
        }
      }
    } catch {
      // Fall back to fresh document if corrupted
    }
  }
  return {
    schemaVersion: 1,
    dateIso,
    hours: {},
  };
}

export async function handleThermalVerifications(
  request: Request,
  bucket: VerificationBucket,
  options: { now?: number } = {},
): Promise<Response> {
  const nowMs = options.now ?? Date.now();
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/thermals/verifications") {
    const dateIso = (url.searchParams.get("date") ?? "").trim();
    const hour = Number(url.searchParams.get("hour"));
    if (!DATE_ISO_RE.test(dateIso) || !Number.isInteger(hour) || hour < MIN_HOUR || hour > MAX_HOUR) {
      return json(400, { error: "expected ?date=YYYY-MM-DD&hour=8..20" });
    }

    const doc = await readDayDocument(bucket, dateIso);
    const hourRec = doc.hours[String(hour)] ?? { entries: [], countsByCell: {} };
    const clientIp = getClientIp(request);
    const existing = hourRec.entries.find((e) => e.ip === clientIp);

    return json(200, {
      dateIso,
      hour,
      isPastHour: isPastBoiseHour(dateIso, hour, nowMs),
      countsByCell: hourRec.countsByCell,
      totalVerifications: hourRec.entries.length,
      userVerified: Boolean(existing),
      userVerifiedCellId: existing ? existing.cellId : null,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/thermals/verify") {
    const body = (await request.json().catch(() => null)) as {
      dateIso?: unknown;
      hour?: unknown;
      cellId?: unknown;
    } | null;

    const dateIso = typeof body?.dateIso === "string" ? body.dateIso.trim() : "";
    const hour = typeof body?.hour === "number" ? body.hour : Number(body?.hour);
    const cellId = typeof body?.cellId === "number" ? body.cellId : Number(body?.cellId);

    if (!DATE_ISO_RE.test(dateIso)) {
      return json(400, { error: "invalid dateIso (expected YYYY-MM-DD)" });
    }
    if (!Number.isInteger(hour) || hour < MIN_HOUR || hour > MAX_HOUR) {
      return json(400, { error: `invalid hour (expected integer ${MIN_HOUR}..${MAX_HOUR})` });
    }
    if (!Number.isInteger(cellId) || cellId < MIN_CELL_ID || cellId > MAX_CELL_ID) {
      return json(400, { error: `invalid cellId (expected integer ${MIN_CELL_ID}..${MAX_CELL_ID})` });
    }
    if (!isPastBoiseHour(dateIso, hour, nowMs)) {
      return json(400, {
        error: "Thermal verification is only allowed for hours that have already passed.",
        isPastHour: false,
      });
    }

    const clientIp = getClientIp(request);
    const doc = await readDayDocument(bucket, dateIso);
    const hourKey = String(hour);
    const hourRec: HourVerificationRecord = doc.hours[hourKey] ?? { entries: [], countsByCell: {} };

    const existing = hourRec.entries.find((e) => e.ip === clientIp);
    if (existing) {
      return json(409, {
        error: "You have already verified a thermal for this hour.",
        dateIso,
        hour,
        userVerified: true,
        userVerifiedCellId: existing.cellId,
        countsByCell: hourRec.countsByCell,
        totalVerifications: hourRec.entries.length,
      });
    }

    const timestamp = new Date(nowMs).toISOString();
    hourRec.entries.push({
      cellId,
      ip: clientIp,
      timestamp,
    });
    const cellKey = String(cellId);
    hourRec.countsByCell[cellKey] = (hourRec.countsByCell[cellKey] ?? 0) + 1;
    doc.hours[hourKey] = hourRec;

    await bucket.put(verificationKey(dateIso), JSON.stringify(doc), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });

    return json(200, {
      ok: true,
      dateIso,
      hour,
      cellId,
      timestamp,
      userVerified: true,
      userVerifiedCellId: cellId,
      countsByCell: hourRec.countsByCell,
      totalVerifications: hourRec.entries.length,
    });
  }

  return json(405, { error: "method not allowed" }, { allow: "GET, POST" });
}

