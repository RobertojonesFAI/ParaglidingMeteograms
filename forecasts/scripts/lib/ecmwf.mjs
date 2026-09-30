// ECMWF IFS forecast for each launch, read from Open-Meteo's API.
//
// ECMWF made its real-time forecasts open data (CC BY 4.0) on 1 October 2025.
// The meteo engine has no ECMWF source, and ECMWF's open fields have no
// surface heat flux, which the soaring meteogram needs for thermal strength.
// So ECMWF gets its own chart panel instead: surface wind and gusts,
// boundary-layer height, cloud layers, and winds aloft.
//
//   surface  ecmwf_ifs     IFS HRES, 9 km; hourly to 90 h, then 3- and 6-hourly
//   aloft    ecmwf_ifs025  IFS open data, 0.25°; 850 and 700 hPa (the 9 km feed
//                          has no pressure levels)
//
// Open-Meteo's free API is for non-commercial use; attribution to Open-Meteo
// and ECMWF is required wherever the data is shown.

export const SCHEMA_VERSION = 1;
export const API = "https://api.open-meteo.com/v1/forecast";
export const SURFACE_MODEL = "ecmwf_ifs";
export const ALOFT_MODEL = "ecmwf_ifs025";
export const USER_AGENT = "ParaglidingMeteograms/0.1 (+https://github.com/RobertojonesFAI/ParaglidingMeteograms)";
export const SOURCE = "ECMWF IFS (CC BY 4.0), via Open-Meteo.com";
const DAYS = 7;
const HOUR = 3_600_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Model run metadata; the path follows Open-Meteo's per-model "static/meta.json" files. */
export const metaUrl = (model) => `https://api.open-meteo.com/data/${model}/static/meta.json`;

// document field -> [Open-Meteo variable, accepted units, decimals]
export const SURFACE_FIELDS = {
  temperatureC: ["temperature_2m", ["°C"], 1],
  dewPointC: ["dew_point_2m", ["°C"], 1],
  windSpeedMps: ["wind_speed_10m", ["m/s"], 1],
  windDirectionDeg: ["wind_direction_10m", ["°"], 0],
  windGustMps: ["wind_gusts_10m", ["m/s"], 1],
  cloudCoverPct: ["cloud_cover", ["%"], 0],
  cloudLowPct: ["cloud_cover_low", ["%"], 0],
  cloudMidPct: ["cloud_cover_mid", ["%"], 0],
  cloudHighPct: ["cloud_cover_high", ["%"], 0],
  precipitationMm: ["precipitation", ["mm"], 1],
  capeJkg: ["cape", ["J/kg"], 0],
  boundaryLayerHeightM: ["boundary_layer_height", ["m"], 0],
  shortwaveWm2: ["shortwave_radiation", ["W/m²", "W/m2"], 0],
};

export const ALOFT_FIELDS = {
  wind850SpeedMps: ["wind_speed_850hPa", ["m/s"], 1],
  wind850DirectionDeg: ["wind_direction_850hPa", ["°"], 0],
  height850M: ["geopotential_height_850hPa", ["m"], 0],
  wind700SpeedMps: ["wind_speed_700hPa", ["m/s"], 1],
  wind700DirectionDeg: ["wind_direction_700hPa", ["°"], 0],
  height700M: ["geopotential_height_700hPa", ["m"], 0],
};

/** A missing or oddly unitised core field fails the launch; any other field is left empty with a warning. */
export const CORE_FIELDS = new Set(["windSpeedMps", "windDirectionDeg", "windGustMps", "boundaryLayerHeightM", "cloudCoverPct"]);

export const UNITS = {
  temperatureC: "°C", dewPointC: "°C", windSpeedMps: "m/s", windDirectionDeg: "° (from)", windGustMps: "m/s",
  cloudCoverPct: "%", cloudLowPct: "%", cloudMidPct: "%", cloudHighPct: "%", precipitationMm: "mm (previous hour)",
  capeJkg: "J/kg", boundaryLayerHeightM: "m above ground", shortwaveWm2: "W/m² (mean over the previous hour)",
  wind850SpeedMps: "m/s", wind850DirectionDeg: "° (from)", height850M: "m above sea level",
  wind700SpeedMps: "m/s", wind700DirectionDeg: "° (from)", height700M: "m above sea level",
};

export const paths = {
  site: (slug) => `ecmwf/sites/${slug}.json`,
  manifest: () => "ecmwf/manifest.json",
};

function query(site, model, fields) {
  const hourly = Object.values(fields).map(([name]) => name).join(",");
  return `${API}?latitude=${site.latitude.toFixed(4)}&longitude=${site.longitude.toFixed(4)}&models=${model}&hourly=${hourly}&wind_speed_unit=ms&timeformat=unixtime&forecast_days=${DAYS + 1}`;
}
export const surfaceUrl = (site) => query(site, SURFACE_MODEL, SURFACE_FIELDS);
export const aloftUrl = (site) => query(site, ALOFT_MODEL, ALOFT_FIELDS);

/** GET JSON with retries on rate limits and server errors; Open-Meteo's own error reason is kept. */
export function createClient({ fetchImpl = globalThis.fetch, retryDelayMs = 2000 } = {}) {
  return async function getJson(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response = null;
      try {
        response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        last = error;
      }
      if (response !== null) {
        if (response.ok) return await response.json();
        const body = await response.text().catch(() => "");
        let reason = "";
        try {
          reason = JSON.parse(body).reason ?? "";
        } catch {
          reason = body.slice(0, 200);
        }
        last = new Error(`GET ${url.split("?")[0]} answered ${response.status}${reason ? `: ${reason}` : ""}`);
        if (!RETRYABLE.has(response.status)) throw last;
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    throw last;
  };
}

const round = (value, digits) => (value === null || value === undefined || Number.isNaN(value) ? null : Number(value.toFixed(digits)));

/** Reads one Open-Meteo response into { times (ms), columns: field -> values }, checking units. */
export function readResponse(response, fields, { label, warn = () => {} }) {
  if (!response?.hourly || !Array.isArray(response.hourly.time)) throw new Error(`${label}: the response has no hourly data`);
  const units = response.hourly_units ?? {};
  if (units.time && units.time !== "unixtime") throw new Error(`${label}: expected unix times, got "${units.time}"`);
  const times = response.hourly.time.map((t) => t * 1000);
  const columns = {};
  for (const [field, [name, accepted, digits]] of Object.entries(fields)) {
    const values = response.hourly[name];
    const unit = units[name];
    let problem = null;
    if (!Array.isArray(values)) problem = `${name} is missing`;
    else if (!accepted.includes(unit)) problem = `${name} came in "${unit}", expected ${accepted.map((u) => `"${u}"`).join(" or ")}`;
    if (problem) {
      if (CORE_FIELDS.has(field)) throw new Error(`${label}: ${problem}`);
      warn(`${label}: ${problem}; left empty this run`);
      columns[field] = times.map(() => null);
      continue;
    }
    columns[field] = values.map((v) => round(typeof v === "number" ? v : null, digits));
  }
  return { times, columns };
}

/** Run time (ISO) from a model's metadata, or null. */
export function runFromMeta(meta) {
  const t = meta?.last_run_initialisation_time;
  return typeof t === "number" && t > 0 ? new Date(t * 1000).toISOString().replace(".000Z", "Z") : null;
}

/**
 * Builds a launch's document from the two responses (aloft may be null when
 * that request failed). Hours run from the current hour for DAYS days.
 */
export function buildSiteDocument({ site, surface, aloft, runs = {}, now = Date.now(), warn = () => {} }) {
  const s = readResponse(surface, SURFACE_FIELDS, { label: `${site.slug} ${SURFACE_MODEL}`, warn });
  let a = null;
  if (aloft) {
    try {
      a = readResponse(aloft, ALOFT_FIELDS, { label: `${site.slug} ${ALOFT_MODEL}`, warn });
    } catch (error) {
      warn(`${error.message}; winds aloft left empty this run`);
    }
  }
  const aloftIndex = new Map((a?.times ?? []).map((t, i) => [t, i]));
  const start = Math.floor(now / HOUR) * HOUR;
  const end = start + DAYS * 24 * HOUR;
  const hours = [];
  s.times.forEach((t, i) => {
    if (t < start || t > end) return;
    const row = { validAt: new Date(t).toISOString().replace(".000Z", "Z") };
    for (const field of Object.keys(SURFACE_FIELDS)) row[field] = s.columns[field][i];
    const j = aloftIndex.get(t);
    for (const field of Object.keys(ALOFT_FIELDS)) row[field] = j === undefined ? null : a.columns[field][j];
    // Open-Meteo pads hours past a model's horizon with nulls: skip hours with no core data.
    if (row.windSpeedMps === null && row.boundaryLayerHeightM === null && row.cloudCoverPct === null) return;
    hours.push(row);
  });
  if (hours.length === 0) throw new Error(`${site.slug}: ECMWF returned no forecast hours from now on`);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    models: {
      surface: { id: SURFACE_MODEL, label: "ECMWF IFS 9 km", run: runs.surface ?? null },
      aloft: { id: ALOFT_MODEL, label: "ECMWF IFS 0.25°", run: runs.aloft ?? null },
    },
    site: {
      slug: site.slug,
      name: site.name,
      latitude: site.latitude,
      longitude: site.longitude,
      timeZone: site.timeZone,
      gridLatitude: surface.latitude ?? null,
      gridLongitude: surface.longitude ?? null,
      gridElevationM: surface.elevation ?? null,
    },
    units: UNITS,
    hours,
  };
}

/** Fetches both responses (and run times, best effort) for one launch and builds its document. */
export async function fetchSiteDocument(site, getJson, { now = Date.now(), warn = () => {} } = {}) {
  const surface = await getJson(surfaceUrl(site));
  let aloft = null;
  try {
    aloft = await getJson(aloftUrl(site));
  } catch (error) {
    warn(`${site.slug}: ${ALOFT_MODEL} unavailable (${error.message}); winds aloft left empty this run`);
  }
  const run = async (model) => runFromMeta(await getJson(metaUrl(model)).catch(() => null));
  const runs = { surface: await run(SURFACE_MODEL), aloft: await run(ALOFT_MODEL) };
  return buildSiteDocument({ site, surface, aloft, runs, now, warn });
}

export function buildManifest({ now = Date.now(), sites, runs = {} }) {
  return { schemaVersion: SCHEMA_VERSION, source: SOURCE, generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"), runs, sites };
}
