// Keeps the forecast discussion current on Cloudflare's own schedule
// (`triggers.crons` in wrangler.jsonc: every 10 minutes). The GitHub
// workflows publish the same documents, but GitHub starts scheduled runs late,
// sometimes by hours, and the Soaring Forecast and the balloon flights are
// wanted the moment they come out.
//
// Each run reads and writes the dataset bucket directly:
//   nws/offices/<id>.json   for every office in nws/manifest.json: asks
//                           api.weather.gov for the latest Area Forecast
//                           Discussion and Soaring Forecast, and rewrites the
//                           document only when one of them is new
//   raob/sites/<slug>.json  for every launch in sites.json with an upper-air
//                           station nearby: once the latest 00/12 UTC flight is
//                           due and not published yet, fetches it and puts it in
//                           front of the previous flight
//   status/refresh.json     what the last run found, to check that it works
//
// The documents are built by the same code the GitHub workflows use
// (forecasts/scripts/lib), so both writers publish the same format.

import { createClient as createNwsClient, fetchOfficeDocument, officeProductsChanged, paths as nwsPaths } from "../../forecasts/scripts/lib/nws.mjs";
import {
  buildSiteDocument,
  createClient as createRaobClient,
  dueLaunchTime,
  fetchSounding,
  mergeSoundings,
  nearestStation,
  paths as raobPaths,
} from "../../forecasts/scripts/lib/raob.mjs";

export interface Bucket {
  get(key: string): Promise<{ text?(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

interface OfficeProduct {
  id: string;
  issuanceTime: string;
  text: string;
}
interface OfficeDocument {
  office: string;
  products: { afd: OfficeProduct | null; srg: OfficeProduct | null };
}
interface Sounding {
  validAt: string;
  levels: unknown[];
}
interface Site {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface OfficeStatus {
  office: string;
  afdIssuanceTime: string | null;
  srgIssuanceTime: string | null;
  updated: boolean;
  error?: string;
}
export interface BalloonStatus {
  station: string;
  published: string | null;
  due: string | null;
  updated: string[];
  note?: string;
  error?: string;
}
export interface RefreshStatus {
  ranAt: string;
  offices: OfficeStatus[];
  balloons: BalloonStatus[];
}

const HOUR = 3_600_000;
/** After this long without the flight in the archive, look for it once an hour only. */
const HOURLY_AFTER_H = 4;
const OFFICE_ID = /^[A-Z]{3}$/;
const JSON_METADATA = { httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=300" } };

async function readJson<T>(bucket: Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object?.text) return null;
  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

const writeJson = (bucket: Bucket, key: string, doc: unknown, pretty = false) =>
  bucket.put(key, `${pretty ? JSON.stringify(doc, null, 1) : JSON.stringify(doc)}\n`, JSON_METADATA);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");

async function refreshOffices(bucket: Bucket, fetchImpl: typeof fetch, now: number, retryDelayMs: number): Promise<OfficeStatus[]> {
  const manifest = await readJson<{ offices?: { office?: string }[] }>(bucket, nwsPaths.manifest());
  const offices = [...new Set((manifest?.offices ?? []).map((o) => o.office).filter((o): o is string => typeof o === "string" && OFFICE_ID.test(o)))];
  const getJson = createNwsClient({ fetchImpl, retryDelayMs });
  const out: OfficeStatus[] = [];
  for (const office of offices) {
    const key = nwsPaths.office(office);
    const previous = await readJson<OfficeDocument>(bucket, key);
    const warnings: string[] = [];
    try {
      const doc: OfficeDocument = await fetchOfficeDocument(office, getJson, { now, warn: (m: string) => warnings.push(m), previous });
      const updated = officeProductsChanged(previous, doc);
      if (updated) await writeJson(bucket, key, doc, true);
      out.push({
        office,
        afdIssuanceTime: doc.products.afd?.issuanceTime ?? null,
        srgIssuanceTime: doc.products.srg?.issuanceTime ?? null,
        updated,
        ...(warnings.length ? { error: warnings.join("; ") } : {}),
      });
    } catch (error) {
      out.push({ office, afdIssuanceTime: null, srgIssuanceTime: null, updated: false, error: message(error) });
    }
  }
  return out;
}

async function refreshBalloons(bucket: Bucket, fetchImpl: typeof fetch, now: number, retryDelayMs: number): Promise<BalloonStatus[]> {
  const sitesDoc = await readJson<{ sites?: Site[] }>(bucket, "sites.json");
  const byStation = new Map<string, { station: ReturnType<typeof nearestStation>; sites: { site: Site; doc: { soundings?: Sounding[] } | null }[] }>();
  for (const site of sitesDoc?.sites ?? []) {
    const station = nearestStation(site);
    if (!station) continue;
    const doc = await readJson<{ soundings?: Sounding[] }>(bucket, raobPaths.site(site.slug));
    if (!byStation.has(station.id)) byStation.set(station.id, { station, sites: [] });
    byStation.get(station.id)!.sites.push({ site, doc });
  }

  const getJson = createRaobClient({ fetchImpl, retryDelayMs });
  const out: BalloonStatus[] = [];
  for (const [id, { station, sites }] of byStation) {
    // The station is due when any of its launches lacks the latest flight.
    const newestPerSite = sites.map(({ doc }) => doc?.soundings?.[0]?.validAt ?? null);
    const oldest = newestPerSite.includes(null) ? null : newestPerSite.sort((a, b) => Date.parse(a!) - Date.parse(b!))[0];
    const due = dueLaunchTime(oldest, now);
    const status: BalloonStatus = { station: id, published: oldest, due: due === null ? null : iso(due), updated: [] };
    out.push(status);
    if (due === null) continue;
    if (now - due > HOURLY_AFTER_H * HOUR && new Date(now).getUTCMinutes() >= 10) {
      status.note = "not in the archive yet; checking once an hour";
      continue;
    }
    try {
      const sounding = (await fetchSounding(station, getJson, due)) as Sounding | null;
      if (!sounding) {
        status.note = "not in the archive yet";
        continue;
      }
      for (const { site, doc } of sites) {
        if (Date.parse(doc?.soundings?.[0]?.validAt ?? "") >= Date.parse(sounding.validAt)) continue;
        const soundings = mergeSoundings(sounding, doc?.soundings ?? []);
        await writeJson(bucket, raobPaths.site(site.slug), buildSiteDocument({ site, station, soundings, now }));
        status.updated.push(site.slug);
      }
    } catch (error) {
      status.error = message(error);
    }
  }
  return out;
}

/** One scheduled run. Never throws: problems are recorded in status/refresh.json. */
export async function refresh(
  bucket: Bucket,
  { now = Date.now(), fetchImpl = fetch, retryDelayMs = 2000 }: { now?: number; fetchImpl?: typeof fetch; retryDelayMs?: number } = {},
): Promise<RefreshStatus> {
  const status: RefreshStatus = { ranAt: iso(now), offices: [], balloons: [] };
  const [offices, balloons] = await Promise.allSettled([
    refreshOffices(bucket, fetchImpl, now, retryDelayMs),
    refreshBalloons(bucket, fetchImpl, now, retryDelayMs),
  ]);
  if (offices.status === "fulfilled") status.offices = offices.value;
  else status.offices = [{ office: "*", afdIssuanceTime: null, srgIssuanceTime: null, updated: false, error: message(offices.reason) }];
  if (balloons.status === "fulfilled") status.balloons = balloons.value;
  else status.balloons = [{ station: "*", published: null, due: null, updated: [], error: message(balloons.reason) }];
  try {
    await writeJson(bucket, "status/refresh.json", status, true);
  } catch (error) {
    console.error(`status/refresh.json: ${message(error)}`);
  }
  console.log(JSON.stringify(status));
  return status;
}
