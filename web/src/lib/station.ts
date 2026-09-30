// Weather stations at or near a launch: the document the Worker serves at
// /api/stations/<id>, how it is built from Weather Underground's personal
// weather station (PWS) API, and how the page reads it for pilots.
//
// Stations are listed in src/data/stations.json. The Worker fetches a station
// only when someone views it (current conditions at most every 2 minutes, the
// 5-minute history at most every 10), keeps the result in the bucket, and holds
// the API key as a secret, so the key never reaches the browser.
//
// Plain TypeScript with erasable syntax only: the Worker, the browser and
// `node --test` all run it unchanged.

import { inArc, type DirectionArc } from "./launches.ts";

export const SCHEMA_VERSION = 1;
export const SOURCE = "Weather Underground personal weather station network (The Weather Company)";
export const WU_API = "https://api.weather.com/v2/pws";

export interface StationConfig {
  provider: "wunderground";
  name: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  /** Launch slugs this station is shown on. */
  launches: string[];
}

export interface StationsFile {
  schemaVersion: 1;
  stations: Record<string, StationConfig>;
}

/** One report: what the station measured at `observedAt`. */
export interface StationObservation {
  observedAt: string;
  windDirectionDeg: number | null;
  windSpeedMps: number | null;
  windGustMps: number | null;
  temperatureC: number | null;
  dewPointC: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;
  solarRadiationWm2: number | null;
  uvIndex: number | null;
  precipRateMmH: number | null;
  precipTodayMm: number | null;
}

/** A 5-minute summary ending at `validAt`. */
export interface StationInterval {
  validAt: string;
  windDirectionDeg: number | null;
  /** Mean wind over the 5 minutes. */
  windSpeedMps: number | null;
  /** Strongest gust in the 5 minutes. */
  windGustMps: number | null;
  temperatureC: number | null;
  dewPointC: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;
  solarRadiationWm2: number | null;
}

export interface StationDocument {
  schemaVersion: 1;
  source: string;
  station: { id: string; name: string; latitude: number; longitude: number; elevationM: number; url: string };
  current: StationObservation | null;
  currentFetchedAt: string | null;
  history: StationInterval[];
  historyFetchedAt: string | null;
  /** Problems with the latest fetch; the data above is then the previous copy. */
  errors?: string[];
}

export const STATION_ID = /^[A-Z0-9]{3,20}$/;
export const dashboardUrl = (id: string) => `https://www.wunderground.com/dashboard/pws/${id}`;

// ── Weather Underground units ────────────────────────────────────────────
// The API puts measured values in an object named after the unit system that
// was asked for. Every system it has is handled, so a change of `units` or of
// the API's default cannot mislabel a value.

type Converters = { speed: (v: number) => number; temp: (v: number) => number; pressure: (v: number) => number; precip: (v: number) => number };
const kmh = (v: number) => v / 3.6;
const mphToMps = (v: number) => v * 0.44704;
const same = (v: number) => v;
const UNIT_SYSTEMS: Record<string, Converters> = {
  metric: { speed: kmh, temp: same, pressure: same, precip: same },
  metric_si: { speed: same, temp: same, pressure: same, precip: same },
  imperial: { speed: mphToMps, temp: (v) => ((v - 32) * 5) / 9, pressure: (v) => v * 33.8639, precip: (v) => v * 25.4 },
  uk_hybrid: { speed: mphToMps, temp: same, pressure: same, precip: same },
};

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, digits = 1) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const conv = (v: unknown, f: (x: number) => number, digits = 1) => {
  const n = num(v);
  return n === null ? null : round(f(n), digits);
};

function unitsOf(row: Raw): { values: Raw; c: Converters } | null {
  for (const [key, c] of Object.entries(UNIT_SYSTEMS)) {
    const values = row[key];
    if (values && typeof values === "object") return { values: values as Raw, c };
  }
  return null;
}

const direction = (v: unknown) => {
  const n = num(v);
  return n === null ? null : ((Math.round(n) % 360) + 360) % 360;
};

function instant(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(".000Z", "Z");
}

/** `observations/current` → the latest report, or null when the station sent none. */
export function parseWuCurrent(body: unknown): StationObservation | null {
  const row = (body as { observations?: Raw[] } | null)?.observations?.[0];
  if (!row) return null;
  const observedAt = instant(row.obsTimeUtc);
  const units = unitsOf(row);
  if (!observedAt || !units) return null;
  const { values: m, c } = units;
  const speed = conv(m.windSpeed, c.speed);
  return {
    observedAt,
    // WU reports a direction even in calm air; it means nothing without wind.
    windDirectionDeg: speed ? direction(row.winddir) : null,
    windSpeedMps: speed,
    windGustMps: conv(m.windGust, c.speed),
    temperatureC: conv(m.temp, c.temp),
    dewPointC: conv(m.dewpt, c.temp),
    humidityPct: round(num(row.humidity), 0),
    pressureHpa: conv(m.pressure, c.pressure),
    solarRadiationWm2: round(num(row.solarRadiation), 0),
    uvIndex: round(num(row.uv), 1),
    precipRateMmH: conv(m.precipRate, c.precip),
    precipTodayMm: conv(m.precipTotal, c.precip),
  };
}

/** `observations/all/1day` → 5-minute summaries, oldest first. */
export function parseWuHistory(body: unknown): StationInterval[] {
  const rows = (body as { observations?: Raw[] } | null)?.observations ?? [];
  const out: StationInterval[] = [];
  for (const row of rows) {
    const validAt = instant(row.obsTimeUtc);
    const units = unitsOf(row);
    if (!validAt || !units) continue;
    const { values: m, c } = units;
    const speed = conv(m.windspeedAvg, c.speed);
    out.push({
      validAt,
      windDirectionDeg: speed ? direction(row.winddirAvg) : null,
      windSpeedMps: speed,
      windGustMps: conv(m.windgustHigh, c.speed),
      temperatureC: conv(m.tempAvg, c.temp),
      dewPointC: conv(m.dewptAvg, c.temp),
      humidityPct: round(num(row.humidityAvg), 0),
      pressureHpa: conv(m.pressureMax, c.pressure),
      solarRadiationWm2: round(num(row.solarRadiationHigh), 0),
    });
  }
  out.sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt));
  return out;
}

// ── Reading the station for pilots ───────────────────────────────────────

/** A report older than this means the station is offline. */
export const STALE_MINUTES = 20;
/** Gusts are judged over this window of 5-minute summaries, plus the current report. */
export const GUST_WINDOW_MINUTES = 15;

export interface WindLimits {
  window: DirectionArc;
  windMinMph: number;
  windMaxMph: number;
  gustMaxMph: number;
}

/** Same scale as the rest of the page: good (green), caution (amber), warning (red), neutral. */
export type Tone = "good" | "neutral" | "caution" | "warning";
export interface Check {
  label: string;
  tone: Tone;
  text: string;
}
export interface WindReading {
  /** Overall call: good only when every check is good. */
  tone: Tone;
  headline: string;
  checks: Check[];
  /** Strongest gust in the current report and the last GUST_WINDOW_MINUTES, m/s. */
  gustMps: number | null;
}

const MPS_TO_MPH = 2.23694;

export function isStale(current: StationObservation | null, now: number): boolean {
  return !current || now - Date.parse(current.observedAt) > STALE_MINUTES * 60_000;
}

/** Strongest gust in the current report and the 5-minute summaries of the last 15 minutes. */
export function recentGust(doc: Pick<StationDocument, "current" | "history">, now: number): number | null {
  const since = now - GUST_WINDOW_MINUTES * 60_000;
  const gusts = [doc.current?.windGustMps ?? null, ...doc.history.filter((h) => Date.parse(h.validAt) >= since).map((h) => h.windGustMps)];
  const known = gusts.filter((g): g is number => g !== null);
  return known.length ? Math.max(...known) : null;
}

/**
 * Compares the station's wind with the launch's limits. `compass` names a
 * direction (e.g. "SSW"). Returns null when there is no wind reading.
 */
export function readWind(current: StationObservation, gustMps: number | null, limits: WindLimits, compass: (deg: number) => string, windowLabel: string): WindReading | null {
  if (current.windSpeedMps === null) return null;
  const speed = current.windSpeedMps * MPS_TO_MPH;
  const gust = gustMps === null ? null : gustMps * MPS_TO_MPH;
  const deg = current.windDirectionDeg;
  const mph = (v: number) => `${Math.round(v)} mph`;
  const checks: Check[] = [];

  if (deg === null || speed < 1) {
    checks.push({ label: "Direction", tone: "neutral", text: "Calm: no steady direction" });
  } else if (inArc(deg, limits.window)) {
    checks.push({ label: "Direction", tone: "good", text: `From ${compass(deg)} (${deg}°), inside the window ${windowLabel}` });
  } else {
    checks.push({ label: "Direction", tone: "warning", text: `From ${compass(deg)} (${deg}°), outside the window ${windowLabel}` });
  }

  if (speed > limits.windMaxMph) checks.push({ label: "Speed", tone: "warning", text: `${mph(speed)}: stronger than ${limits.windMaxMph} mph` });
  else if (speed < limits.windMinMph) checks.push({ label: "Speed", tone: "caution", text: `${mph(speed)}: lighter than ${limits.windMinMph} mph` });
  else checks.push({ label: "Speed", tone: "good", text: `${mph(speed)}: within ${limits.windMinMph}–${limits.windMaxMph} mph` });

  if (gust === null) checks.push({ label: "Gusts", tone: "neutral", text: "No gust reading" });
  else if (gust > limits.gustMaxMph) checks.push({ label: "Gusts", tone: "warning", text: `Up to ${mph(gust)} in the last ${GUST_WINDOW_MINUTES} min: over ${limits.gustMaxMph} mph` });
  else checks.push({ label: "Gusts", tone: "good", text: `Up to ${mph(gust)} in the last ${GUST_WINDOW_MINUTES} min: under ${limits.gustMaxMph} mph` });

  const tones = checks.map((c) => c.tone);
  const tone: Tone = tones.includes("warning") ? "warning" : tones.every((t) => t === "good") ? "good" : "caution";
  const headline =
    tone === "good"
      ? "Within this launch's limits"
      : tone === "warning"
        ? `Outside limits: ${checks.filter((c) => c.tone === "warning").map((c) => c.label.toLowerCase()).join(", ")}`
        : deg === null || speed < 1
          ? "Calm or nearly calm"
          : "Light wind";
  return { tone, headline, checks, gustMps };
}

const EMPTY: Omit<StationInterval, "validAt"> = {
  windDirectionDeg: null,
  windSpeedMps: null,
  windGustMps: null,
  temperatureC: null,
  dewPointC: null,
  humidityPct: null,
  pressureHpa: null,
  solarRadiationWm2: null,
};

/**
 * The history on a regular grid of `stepMinutes` slots covering the last
 * `hours` up to now. A slot with no report has every value null, so the chart
 * shows a gap instead of joining across it.
 */
export function historyGrid(history: StationInterval[], { hours = 12, stepMinutes = 5, now = Date.now() } = {}): StationInterval[] {
  const step = stepMinutes * 60_000;
  const bySlot = new Map<number, StationInterval>();
  for (const h of history) bySlot.set(Math.round(Date.parse(h.validAt) / step) * step, h);
  const end = Math.floor(now / step) * step;
  const start = end - hours * 3_600_000 + step;
  const out: StationInterval[] = [];
  for (let t = start; t <= end; t += step) {
    const validAt = new Date(t).toISOString().replace(".000Z", "Z");
    const slot = bySlot.get(t);
    out.push(slot ? { ...slot, validAt } : { validAt, ...EMPTY });
  }
  return out;
}
