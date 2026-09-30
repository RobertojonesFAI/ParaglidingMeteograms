// GET /api/stations/<id>: a weather station's latest report and its last
// hours in 5-minute steps (the StationDocument in src/lib/station.ts).
//
// Only stations listed in src/data/stations.json are served. Weather
// Underground is asked only when a page wants the data and the copy in the
// bucket (stations/<id>/latest.json) is older than 2 minutes for the current
// report or 10 minutes for the history, which keeps well inside the API's
// daily allowance however many people are watching. The API key is the
// WU_API_KEY secret; it never appears in a response, the bucket or the logs.

import stationsFile from "../src/data/stations.json" with { type: "json" };
import {
  SCHEMA_VERSION,
  SOURCE,
  STATION_ID,
  WU_API,
  dashboardUrl,
  parseWuCurrent,
  parseWuHistory,
  type StationConfig,
  type StationDocument,
  type StationsFile,
} from "../src/lib/station.ts";

export interface StationBucket {
  get(key: string): Promise<{ text?(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

export const CURRENT_MAX_AGE_MS = 2 * 60_000;
export const HISTORY_MAX_AGE_MS = 10 * 60_000;
const FEET = 0.3048;
const stations = (stationsFile as StationsFile).stations;

export const stationKey = (id: string) => `stations/${id}/latest.json`;

function json(status: number, body: unknown, cacheControl = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl, "x-content-type-options": "nosniff" },
  });
}

class WuError extends Error {}

/** GET one WU endpoint. 204 (no report) is null. Errors never carry the URL, which holds the key. */
async function getWu(fetchImpl: typeof fetch, path: string, id: string, apiKey: string): Promise<unknown> {
  const url = `${WU_API}/${path}?stationId=${encodeURIComponent(id)}&format=json&units=m&numericPrecision=decimal&apiKey=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new WuError(`${path}: ${error instanceof Error && error.name === "TimeoutError" ? "timed out" : "network error"}`);
  }
  if (response.status === 204) return null;
  if (response.status === 401 || response.status === 403) throw new WuError(`${path}: the API key was refused (${response.status})`);
  if (!response.ok) throw new WuError(`${path}: Weather Underground answered ${response.status}`);
  return response.json();
}

function emptyDocument(id: string, config: StationConfig): StationDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    station: {
      id,
      name: config.name,
      latitude: config.latitude,
      longitude: config.longitude,
      elevationM: Math.round(config.elevationFt * FEET),
      url: dashboardUrl(id),
    },
    current: null,
    currentFetchedAt: null,
    history: [],
    historyFetchedAt: null,
  };
}

const age = (iso: string | null, now: number) => (iso ? now - Date.parse(iso) : Number.POSITIVE_INFINITY);

export async function serveStation(
  request: Request,
  env: { DATA: StationBucket; WU_API_KEY?: string },
  id: string,
  { now = Date.now(), fetchImpl = fetch }: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" });
  const config = STATION_ID.test(id) ? stations[id] : undefined;
  if (!config) return json(404, { error: "not found" });
  if (!env.WU_API_KEY) return json(503, { error: "not connected", url: dashboardUrl(id) }, "public, max-age=300");

  const key = stationKey(id);
  let doc: StationDocument = emptyDocument(id, config);
  try {
    const cached = await env.DATA.get(key);
    if (cached?.text) doc = { ...doc, ...(JSON.parse(await cached.text()) as StationDocument), station: doc.station };
  } catch {
    // A missing or unreadable copy is fetched afresh below.
  }

  const needCurrent = age(doc.currentFetchedAt, now) >= CURRENT_MAX_AGE_MS;
  const needHistory = age(doc.historyFetchedAt, now) >= HISTORY_MAX_AGE_MS;
  if (needCurrent || needHistory) {
    const stamp = new Date(now).toISOString().replace(".000Z", "Z");
    const errors: string[] = [];
    const [current, history] = await Promise.allSettled([
      needCurrent ? getWu(fetchImpl, "observations/current", id, env.WU_API_KEY) : Promise.resolve(undefined),
      needHistory ? getWu(fetchImpl, "observations/all/1day", id, env.WU_API_KEY) : Promise.resolve(undefined),
    ]);
    let changed = false;
    if (needCurrent) {
      if (current.status === "fulfilled") {
        doc.current = parseWuCurrent(current.value) ?? doc.current;
        doc.currentFetchedAt = stamp;
        changed = true;
      } else errors.push(current.reason instanceof WuError ? current.reason.message : "current report failed");
    }
    if (needHistory) {
      if (history.status === "fulfilled") {
        const rows = parseWuHistory(history.value);
        if (rows.length > 0 || history.value === null) doc.history = rows;
        doc.historyFetchedAt = stamp;
        changed = true;
      } else errors.push(history.reason instanceof WuError ? history.reason.message : "history failed");
    }
    if (errors.length) doc.errors = errors;
    else delete doc.errors;
    if (changed) {
      const stored: StationDocument = { ...doc };
      delete stored.errors;
      await env.DATA.put(key, `${JSON.stringify(stored)}\n`, { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } }).catch(() => {});
    }
    if (errors.length) console.warn(`station ${id}: ${errors.join("; ")}`);
  }

  if (!doc.current && doc.history.length === 0 && doc.errors?.length) return json(502, { error: "station data unavailable", details: doc.errors });
  return json(200, doc, "public, max-age=30");
}
