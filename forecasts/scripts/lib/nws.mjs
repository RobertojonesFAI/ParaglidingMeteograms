// National Weather Service (NOAA) point forecasts from api.weather.gov.
//
// For a launch's coordinates this collects:
//   - the forecast grid (forecastGridData): the same NDFD data behind the
//     forecast.weather.gov hourly graph, expanded to one row per hour
//   - the hourly forecast's short text ("Sunny", "Chance T-storms") per hour
//   - the 12-hour text periods ("Tonight: Mostly clear, ...")
// and, per forecast office, the latest Area Forecast Discussion (AFD) and,
// where the office issues one, the Soaring Forecast (SRG).
//
// No API key is needed. NWS asks every client to send a User-Agent that
// identifies the application and a way to contact its operator.

export const SCHEMA_VERSION = 1;
export const API = "https://api.weather.gov";
export const DEFAULT_USER_AGENT =
  "ParaglidingMeteograms/0.1 (+https://github.com/RobertojonesFAI/ParaglidingMeteograms)";

const HOUR = 3_600_000;
const MAX_HOURS = 7 * 24;

// ── units ────────────────────────────────────────────────────────────────

// Every published field has one unit. NWS declares a unit (uom) per grid
// layer; anything not in this table fails loudly instead of being mislabeled.
const CONVERSIONS = {
  speed: {
    "wmoUnit:km_h-1": (v) => v / 3.6,
    "wmoUnit:m_s-1": (v) => v,
    "wmoUnit:kn": (v) => v * 0.514444,
  },
  temperature: {
    "wmoUnit:degC": (v) => v,
    "wmoUnit:degF": (v) => ((v - 32) * 5) / 9,
  },
  length: {
    "wmoUnit:m": (v) => v,
    "wmoUnit:km": (v) => v * 1000,
    "wmoUnit:ft": (v) => v * 0.3048,
  },
  percent: { "wmoUnit:percent": (v) => v },
  angle: { "wmoUnit:degree_(angle)": (v) => v },
  index: { "nwsUnit:n/a": (v) => v, "wmoUnit:1": (v) => v },
};

// Published field -> [NWS grid layer, unit class, decimals].
export const FIELDS = {
  temperatureC: ["temperature", "temperature", 1],
  dewpointC: ["dewpoint", "temperature", 1],
  relativeHumidityPct: ["relativeHumidity", "percent", 0],
  skyCoverPct: ["skyCover", "percent", 0],
  windDirectionDeg: ["windDirection", "angle", 0],
  windSpeedMps: ["windSpeed", "speed", 1],
  windGustMps: ["windGust", "speed", 1],
  precipitationProbabilityPct: ["probabilityOfPrecipitation", "percent", 0],
  thunderProbabilityPct: ["probabilityOfThunder", "percent", 0],
  lightningActivityLevel: ["lightningActivityLevel", "index", 0],
  mixingHeightM: ["mixingHeight", "length", 0],
  transportWindDirectionDeg: ["transportWindDirection", "angle", 0],
  transportWindSpeedMps: ["transportWindSpeed", "speed", 1],
  ceilingHeightM: ["ceilingHeight", "length", 0],
  visibilityM: ["visibility", "length", 0],
};

export const UNITS = {
  temperatureC: "°C",
  dewpointC: "°C",
  relativeHumidityPct: "%",
  skyCoverPct: "%",
  windDirectionDeg: "degrees true, direction the wind blows from",
  windSpeedMps: "m/s, 10 m above ground",
  windGustMps: "m/s, 10 m above ground",
  precipitationProbabilityPct: "%",
  thunderProbabilityPct: "%",
  lightningActivityLevel: "LAL 1-6 (1 = no thunderstorms, 6 = dry lightning)",
  mixingHeightM: "m above ground level",
  transportWindDirectionDeg: "degrees true, mean wind through the mixed layer",
  transportWindSpeedMps: "m/s, mean wind through the mixed layer",
  ceilingHeightM: "m above ground level",
  visibilityM: "m",
  weather: "NWS weather coverage and type, e.g. 'slight_chance thunderstorms'",
  shortForecast: "NWS hourly short text",
};

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Percentages and indices have no physical unit; NWS sometimes omits the uom
// on those layers (seen on probabilityOfThunder), and that is not ambiguous.
const UNITLESS = new Set(["percent", "index"]);

/** Fields the forecast is useless without: an unknown unit on these stops the launch. */
export const CORE_FIELDS = new Set(["temperatureC", "windSpeedMps", "windGustMps", "windDirectionDeg"]);

function converter(field, uom) {
  const [, unitClass] = FIELDS[field];
  if (uom == null && UNITLESS.has(unitClass)) return (v) => v;
  const fn = CONVERSIONS[unitClass][uom];
  if (!fn) throw new Error(`${field}: unexpected NWS unit "${uom}" for a ${unitClass} value`);
  return fn;
}

export function convert(field, uom, value) {
  if (value === null || value === undefined) return null;
  return round(converter(field, uom)(value), FIELDS[field][2]);
}

// ── time ─────────────────────────────────────────────────────────────────

/** ISO 8601 duration as used by NWS validTime intervals (P1DT6H, PT1H, P7D) -> ms. */
export function parseDuration(text) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(text);
  if (!match || text === "P" || text.endsWith("T")) throw new Error(`unsupported ISO 8601 duration "${text}"`);
  const [, days = "0", hours = "0", minutes = "0"] = match;
  return (Number(days) * 24 + Number(hours)) * HOUR + Number(minutes) * 60_000;
}

/** "2026-09-29T18:00:00+00:00/PT3H" -> { start, end } in epoch ms. */
export function parseValidTime(validTime) {
  const [startText, durationText] = validTime.split("/");
  const start = Date.parse(startText);
  if (Number.isNaN(start) || durationText === undefined) throw new Error(`unsupported validTime "${validTime}"`);
  return { start, end: start + parseDuration(durationText) };
}

const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;

/** Expands a grid layer's intervals to a Map of hour start (epoch ms) -> raw value. */
export function expandLayer(layer) {
  const hours = new Map();
  for (const { validTime, value } of layer?.values ?? []) {
    const { start, end } = parseValidTime(validTime);
    for (let t = floorHour(start); t < end; t += HOUR) hours.set(t, value);
  }
  return hours;
}

/** NWS weather value (array of conditions) -> "chance rain_showers; slight_chance thunderstorms" or null. */
export function describeWeather(value) {
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((c) => [c?.coverage, c?.intensity, c?.weather].filter(Boolean).join(" "))
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("; ") : null;
}

// ── document assembly (pure) ─────────────────────────────────────────────

/**
 * Builds one launch's document from already-fetched API responses.
 * `hourly` and `forecast` may be null when those endpoints failed.
 *
 * A layer whose unit is not recognised is never published with a guessed
 * unit: a core field (wind, gust, direction, temperature) stops the launch,
 * any other field is left empty for this run with a warning.
 */
export function buildSiteDocument({ site, point, grid, hourly, forecast, now = Date.now(), warn = console.warn }) {
  const props = grid.properties;
  const layers = {};
  for (const [field, [layerName]] of Object.entries(FIELDS)) {
    const layer = props[layerName];
    const hours = expandLayer(layer);
    const uom = layer?.uom ?? null;
    const hasValues = [...hours.values()].some((v) => v !== null && v !== undefined);
    if (hasValues) {
      try {
        converter(field, uom);
      } catch (error) {
        if (CORE_FIELDS.has(field)) throw error;
        warn(`${site.slug}: ${error.message}; ${field} left empty this run`);
        hours.clear();
      }
    }
    layers[field] = { uom, hours };
  }
  const weather = expandLayer(props.weather);

  const shortText = new Map();
  for (const period of hourly?.properties?.periods ?? []) {
    shortText.set(floorHour(Date.parse(period.startTime)), period.shortForecast ?? null);
  }

  // The forecast spans the hours the core layers cover, from the current hour on.
  const covered = [...layers.temperatureC.hours.keys(), ...layers.windSpeedMps.hours.keys()];
  if (covered.length === 0) throw new Error("the forecast grid has no temperature or wind values");
  const first = floorHour(now);
  const last = Math.min(Math.max(...covered), first + (MAX_HOURS - 1) * HOUR);

  const hours = [];
  for (let t = first; t <= last; t += HOUR) {
    const row = { validAt: new Date(t).toISOString() };
    for (const [field, { uom, hours: values }] of Object.entries(layers)) {
      row[field] = values.has(t) ? convert(field, uom, values.get(t)) : null;
    }
    row.weather = describeWeather(weather.get(t));
    row.shortForecast = shortText.get(t) ?? null;
    hours.push(row);
  }

  const periods = (forecast?.properties?.periods ?? []).map((p) => ({
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    isDaytime: p.isDaytime,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast,
  }));

  const pointProps = point.properties;
  const elevation = props.elevation;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "National Weather Service (NOAA), api.weather.gov",
    generatedAt: new Date(now).toISOString(),
    updateTime: props.updateTime ?? null,
    hourlyUpdateTime: hourly?.properties?.updateTime ?? null,
    periodsUpdateTime: forecast?.properties?.updateTime ?? null,
    site: {
      slug: site.slug,
      name: site.name,
      latitude: site.latitude,
      longitude: site.longitude,
      timeZone: site.timeZone,
    },
    grid: {
      office: pointProps.gridId,
      x: pointProps.gridX,
      y: pointProps.gridY,
      elevationM: elevation?.value == null ? null : round(convert("ceilingHeightM", elevation.unitCode, elevation.value), 0),
    },
    pageUrl: forecastPageUrl(site),
    units: UNITS,
    hours,
    periods,
  };
}

export function forecastPageUrl(site) {
  return `https://forecast.weather.gov/MapClick.php?lat=${site.latitude.toFixed(4)}&lon=${site.longitude.toFixed(4)}`;
}

export function buildManifest({ now = Date.now(), sites, offices }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "National Weather Service (NOAA), api.weather.gov",
    generatedAt: new Date(now).toISOString(),
    sites,
    offices,
  };
}

export const paths = {
  manifest: () => "nws/manifest.json",
  site: (slug) => `nws/sites/${slug}.json`,
  office: (office) => `nws/offices/${office}.json`,
};

// ── network ──────────────────────────────────────────────────────────────

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * GET a JSON document from api.weather.gov. Returns null on 404; retries
 * transient failures (NWS answers occasional 500/503s); throws otherwise.
 */
export function createClient({ userAgent = DEFAULT_USER_AGENT, fetchImpl = globalThis.fetch, retryDelayMs = 2000 } = {}) {
  return async function getJson(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response = null;
      try {
        response = await fetchImpl(url, {
          headers: { "user-agent": userAgent, accept: "application/geo+json, application/ld+json;q=0.9" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        last = error; // network failure or timeout: retry
      }
      if (response !== null) {
        if (response.status === 404) return null;
        if (response.ok) return await response.json();
        last = new Error(`GET ${url} answered ${response.status}`);
        if (!RETRYABLE.has(response.status)) throw last;
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    throw last;
  };
}

/** Fetches everything for one launch and builds its document. */
export async function fetchSiteDocument(site, getJson, { now = Date.now(), warn = console.warn } = {}) {
  const point = await getJson(`${API}/points/${site.latitude.toFixed(4)},${site.longitude.toFixed(4)}`);
  if (point === null) throw new Error("NWS has no forecast point here (outside the US?)");
  const { forecastGridData, forecastHourly, forecast } = point.properties;

  const grid = await getJson(forecastGridData);
  if (grid === null) throw new Error(`forecast grid not found: ${forecastGridData}`);

  const optional = async (label, url) => {
    try {
      return await getJson(url);
    } catch (error) {
      warn(`${site.slug}: ${label} unavailable (${error.message}); continuing without it`);
      return null;
    }
  };
  const hourly = await optional("hourly forecast", forecastHourly);
  const periods = await optional("text forecast", forecast);

  const document = buildSiteDocument({ site, point, grid, hourly, forecast: periods, now, warn });
  const ageHours = document.updateTime ? (now - Date.parse(document.updateTime)) / HOUR : Infinity;
  if (ageHours > 12) warn(`${site.slug}: NWS grid updateTime ${document.updateTime} is ${Math.round(ageHours)} h old`);
  return document;
}

/** Latest product of a type (AFD, SRG) for an office, or null if the office issues none. */
export async function fetchLatestProduct(getJson, type, office) {
  const list = await getJson(`${API}/products/types/${type}/locations/${office}`);
  const latest = list?.["@graph"]?.[0];
  if (!latest) return null;
  const product = await getJson(`${API}/products/${latest.id}`);
  if (product === null) return null;
  return {
    id: product.id,
    productCode: product.productCode ?? type,
    productName: product.productName ?? null,
    issuanceTime: product.issuanceTime,
    text: product.productText,
  };
}

export async function fetchOfficeDocument(office, getJson, { now = Date.now(), warn = console.warn } = {}) {
  const products = {};
  // AFD: forecasters' reasoning. SRG: Soaring Forecast, only some offices issue it.
  for (const type of ["AFD", "SRG"]) {
    try {
      products[type.toLowerCase()] = await fetchLatestProduct(getJson, type, office);
    } catch (error) {
      warn(`${office}: ${type} unavailable (${error.message})`);
      products[type.toLowerCase()] = null;
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "National Weather Service (NOAA), api.weather.gov",
    generatedAt: new Date(now).toISOString(),
    office,
    products,
  };
}
