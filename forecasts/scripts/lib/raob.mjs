// Weather-balloon (radiosonde) soundings for each launch's nearest upper-air
// station, read from the Iowa Environmental Mesonet's archive of NWS
// radiosonde data (https://mesonet.agron.iastate.edu/archive/raob/).
//
// Balloons go up at 00 and 12 UTC (6 PM and 6 AM in Boise summer time) and the
// archive has them within an hour or two. Each run keeps the two latest.
//
//   raob/sites/<slug>.json   the nearest station's latest soundings, one per launch

export const SCHEMA_VERSION = 1;
export const API = "https://mesonet.agron.iastate.edu/json/raob.py";
export const SOURCE = "NWS radiosonde observations via the Iowa Environmental Mesonet";
export const USER_AGENT = "ParaglidingMeteograms/0.1 (+https://github.com/RobertojonesFAI/ParaglidingMeteograms)";
const KT_TO_MPS = 0.514444;
const HOUR = 3_600_000;
/** Farthest a launch can be from a station and still use its balloon. */
export const MAX_DISTANCE_KM = 300;
/** Levels above this pressure (hPa) are dropped: well above any flying. */
export const TOP_HPA = 250;

/**
 * Upper-air stations of the interior West. Positions are approximate and only
 * pick the nearest station; the published document carries the balloon's own
 * surface height.
 */
export const STATIONS = [
  { id: "KBOI", name: "Boise", latitude: 43.5677, longitude: -116.2109 },
  { id: "KSLC", name: "Salt Lake City", latitude: 40.77, longitude: -111.97 },
  { id: "KOTX", name: "Spokane", latitude: 47.68, longitude: -117.63 },
  { id: "KLKN", name: "Elko", latitude: 40.87, longitude: -115.73 },
  { id: "KREV", name: "Reno", latitude: 39.57, longitude: -119.8 },
  { id: "KMFR", name: "Medford", latitude: 42.37, longitude: -122.88 },
  { id: "KTFX", name: "Great Falls", latitude: 47.46, longitude: -111.39 },
  { id: "KRIU", name: "Riverton", latitude: 43.06, longitude: -108.48 },
  { id: "KGJT", name: "Grand Junction", latitude: 39.12, longitude: -108.53 },
];

export function distanceKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * r;
  const dLon = (b.longitude - a.longitude) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The nearest station within MAX_DISTANCE_KM, or null. */
export function nearestStation(site, stations = STATIONS) {
  let best = null;
  for (const station of stations) {
    const d = distanceKm(site, station);
    if (d <= MAX_DISTANCE_KM && (!best || d < best.distanceKm)) best = { ...station, distanceKm: Math.round(d) };
  }
  return best;
}

/** The latest synoptic launch times (00/12 UTC) at or before `now`, newest first. */
export function recentLaunchTimes(now, count = 4) {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() >= 12 ? 12 : 0);
  const out = [];
  for (let i = 0; i < count; i += 1, t -= 12 * HOUR) out.push(t);
  return out;
}

const stamp = (t) => new Date(t).toISOString().replace(/[-:T]/g, "").slice(0, 10) + "00";
export const soundingUrl = (stationId, t) => `${API}?ts=${stamp(t)}&station=${stationId}`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Normalises one IEM profile into levels, bottom up: pressure (hPa), height
 * (m MSL), temperature and dew point (°C), wind (from °, m/s). Levels without
 * pressure, height or temperature are dropped; repeated pressures keep the first.
 */
export function normalizeProfile(profile) {
  const seen = new Set();
  const levels = [];
  for (const level of profile ?? []) {
    const p = num(level.pres);
    const z = num(level.hght);
    const t = num(level.tmpc);
    if (p === null || z === null || t === null || p < TOP_HPA || seen.has(p)) continue;
    seen.add(p);
    const td = num(level.dwpc);
    const kt = num(level.sknt);
    const dir = num(level.drct);
    levels.push({
      pressureHpa: p,
      heightM: Math.round(z),
      temperatureC: Math.round(t * 10) / 10,
      dewPointC: td === null ? null : Math.round(Math.min(td, t) * 10) / 10,
      windDirectionDeg: kt === null || dir === null ? null : Math.round(dir),
      windSpeedMps: kt === null || dir === null ? null : Math.round(kt * KT_TO_MPS * 10) / 10,
    });
  }
  levels.sort((a, b) => b.pressureHpa - a.pressureHpa);
  // Heights must rise with falling pressure; drop anything out of order.
  const clean = [];
  for (const level of levels) if (clean.length === 0 || level.heightM > clean[clean.length - 1].heightM) clean.push(level);
  return clean;
}

/** GET JSON with retries on rate limits and server errors; null on 404. */
export function createClient({ fetchImpl = globalThis.fetch, retryDelayMs = 2000 } = {}) {
  return async function getJson(url) {
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response = null;
      try {
        response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        last = error;
      }
      if (response !== null) {
        if (response.status === 404) return null;
        if (response.ok) return await response.json();
        last = new Error(`GET ${url} answered ${response.status}`);
        if (![429, 500, 502, 503, 504].includes(response.status)) throw last;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    throw last;
  };
}

/** The station's latest `keep` soundings (newest first) with at least 10 levels. */
export async function fetchStationSoundings(station, getJson, { now = Date.now(), keep = 2, warn = () => {} } = {}) {
  const soundings = [];
  for (const t of recentLaunchTimes(now, 4)) {
    if (soundings.length >= keep) break;
    let body;
    try {
      body = await getJson(soundingUrl(station.id, t));
    } catch (error) {
      warn(`${station.id} ${new Date(t).toISOString()}: ${error.message}`);
      continue;
    }
    const profile = body?.profiles?.[0];
    const levels = normalizeProfile(profile?.profile);
    if (levels.length < 10) continue; // not in yet, or a failed flight
    soundings.push({ validAt: new Date(t).toISOString().replace(".000Z", "Z"), levels });
  }
  return soundings;
}

export function buildSiteDocument({ site, station, soundings, now = Date.now() }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    site: { slug: site.slug, name: site.name },
    station: {
      id: station.id,
      name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
      distanceKm: station.distanceKm,
      elevationM: soundings[0]?.levels[0]?.heightM ?? null,
    },
    soundings,
  };
}

export const paths = { site: (slug) => `raob/sites/${slug}.json` };
