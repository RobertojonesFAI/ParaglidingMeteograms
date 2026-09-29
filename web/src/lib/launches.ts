// Launch records and the rules every writer and reader of them shares.
//
// A launch is split across two files so the forecast engine's catalogue stays
// exactly what the engine accepts:
//   forecasts/sites.json         identity the engine reads: slug, name, coordinates, time zone
//   web/src/data/launches.json   what only the website uses: facing, wind limits, notes
//
// This module is plain TypeScript with erasable syntax only, so the Worker,
// the Astro build, the browser and `node --test` all run it unchanged.

export interface SiteEntry {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string;
}

export interface LaunchDetails {
  /** Direction the launch faces (degrees true); also the centre of the wind window. */
  facingDeg: number;
  /** Half-width of the acceptable wind-direction arc around facingDeg, degrees. */
  windArcHalfWidthDeg: number;
  /** Acceptable surface wind speed range, mph. */
  windMinMph: number;
  windMaxMph: number;
  /** Gusts above this are out of limits, mph. */
  gustMaxMph: number;
  /** Short place label for cards, e.g. "Boise, ID". */
  region: string;
  /** Free-text notes shown on the launch page. */
  notes: string;
}

export interface Launch extends SiteEntry, LaunchDetails {}

export interface SitesFile {
  schemaVersion: 2;
  sites: SiteEntry[];
}

export interface LaunchesFile {
  schemaVersion: 1;
  launches: Record<string, LaunchDetails>;
}

export interface DirectionArc {
  fromDeg: number;
  toDeg: number;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_DETAILS: LaunchDetails = {
  facingDeg: 0,
  windArcHalfWidthDeg: 45,
  windMinMph: 5,
  windMaxMph: 15,
  gustMaxMph: 20,
  region: "",
  notes: "",
};

/** US time zones offered in the admin form (NWS and HRRR cover the US). */
export const TIME_ZONES = [
  "America/Boise",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export const COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const normalize = (deg: number) => ((deg % 360) + 360) % 360;

export function compassPoint(deg: number): string {
  return COMPASS_16[Math.round(normalize(deg) / 22.5) % 16];
}

/** The acceptable wind arc for a launch; wraps through north when fromDeg > toDeg. */
export function windWindow(details: Pick<LaunchDetails, "facingDeg" | "windArcHalfWidthDeg">): DirectionArc {
  return {
    fromDeg: normalize(details.facingDeg - details.windArcHalfWidthDeg),
    toDeg: normalize(details.facingDeg + details.windArcHalfWidthDeg),
  };
}

export function inArc(directionDeg: number, arc: DirectionArc): boolean {
  const d = normalize(directionDeg);
  return arc.fromDeg <= arc.toDeg ? d >= arc.fromDeg && d <= arc.toDeg : d >= arc.fromDeg || d <= arc.toDeg;
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Joins the two files into launches, in sites.json order; details fall back to defaults. */
export function joinLaunches(sites: SitesFile, launches: LaunchesFile): Launch[] {
  return sites.sites.map((site) => ({ ...DEFAULT_DETAILS, ...launches.launches[site.slug], ...site }));
}

/** Cross-file consistency: every catalogued site has details and every detail has a site. */
export function consistencyErrors(sites: SitesFile, launches: LaunchesFile): string[] {
  const errors: string[] = [];
  const slugs = new Set(sites.sites.map((s) => s.slug));
  for (const slug of slugs) if (!(slug in launches.launches)) errors.push(`${slug}: missing from launches.json`);
  for (const slug of Object.keys(launches.launches)) if (!slugs.has(slug)) errors.push(`${slug}: in launches.json but not in sites.json`);
  return errors;
}

const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

/**
 * Validates and normalizes a launch submitted by the admin form.
 * Returns the cleaned launch, or a list of human-readable errors.
 */
export function validateLaunchInput(input: Record<string, unknown>): { launch: Launch } | { errors: string[] } {
  const errors: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  const slug = typeof input.slug === "string" && input.slug.trim() !== "" ? input.slug.trim() : slugify(name);
  const latitude = num(input.latitude);
  const longitude = num(input.longitude);
  const timeZone = typeof input.timeZone === "string" ? input.timeZone : "";
  const facingDeg = num(input.facingDeg);
  const windArcHalfWidthDeg = input.windArcHalfWidthDeg === undefined ? DEFAULT_DETAILS.windArcHalfWidthDeg : num(input.windArcHalfWidthDeg);
  const windMinMph = num(input.windMinMph);
  const windMaxMph = num(input.windMaxMph);
  const gustMaxMph = num(input.gustMaxMph);
  const region = typeof input.region === "string" ? input.region.trim().slice(0, 80) : "";
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : "";

  if (name.length < 2 || name.length > 80) errors.push("Name must be 2 to 80 characters.");
  else if (!SLUG_PATTERN.test(slug)) errors.push("Slug must be lowercase letters, digits and hyphens.");
  const hasLat = typeof input.latitude === "number" || (typeof input.latitude === "string" && input.latitude.trim() !== "");
  const hasLon = typeof input.longitude === "number" || (typeof input.longitude === "string" && input.longitude.trim() !== "");
  if (!hasLat || !hasLon) errors.push("Place the launch on the map, or type its latitude and longitude.");
  else {
    if (!(latitude >= -90 && latitude <= 90)) errors.push("Latitude must be between -90 and 90.");
    if (!(longitude >= -180 && longitude <= 180)) errors.push("Longitude must be between -180 and 180.");
  }
  if (!isValidTimeZone(timeZone)) errors.push("Choose a valid time zone.");
  if (!(facingDeg >= 0 && facingDeg < 360)) errors.push("Choose the direction the launch faces.");
  if (!(windArcHalfWidthDeg >= 10 && windArcHalfWidthDeg <= 90)) errors.push("Wind arc half-width must be between 10° and 90°.");
  if (!(windMinMph >= 0 && windMinMph <= 40)) errors.push("Minimum wind must be between 0 and 40 mph.");
  if (!(windMaxMph > 0 && windMaxMph <= 50)) errors.push("Maximum wind must be between 1 and 50 mph.");
  if (windMinMph >= windMaxMph) errors.push("Minimum wind must be lower than maximum wind.");
  if (!(gustMaxMph >= windMaxMph && gustMaxMph <= 60)) errors.push("Maximum gust must be at least the maximum wind and at most 60 mph.");
  if (errors.length > 0) return { errors };

  return {
    launch: {
      slug,
      name,
      latitude: round5(latitude),
      longitude: round5(longitude),
      timeZone,
      facingDeg: Math.round(facingDeg),
      windArcHalfWidthDeg: Math.round(windArcHalfWidthDeg),
      windMinMph: Math.round(windMinMph),
      windMaxMph: Math.round(windMaxMph),
      gustMaxMph: Math.round(gustMaxMph),
      region,
      notes,
    },
  };
}

/**
 * Applies a create or an update to both files. Creating an existing slug or
 * updating a missing one is an error; a slug never changes on update.
 */
export function applyLaunch(
  sites: SitesFile,
  launches: LaunchesFile,
  launch: Launch,
  mode: "create" | "update",
): { sites: SitesFile; launches: LaunchesFile } | { error: string } {
  const exists = sites.sites.some((s) => s.slug === launch.slug);
  if (mode === "create" && exists) return { error: `A launch with slug "${launch.slug}" already exists.` };
  if (mode === "update" && !exists) return { error: `No launch with slug "${launch.slug}".` };

  const site: SiteEntry = {
    slug: launch.slug,
    name: launch.name,
    latitude: launch.latitude,
    longitude: launch.longitude,
    timeZone: launch.timeZone,
  };
  const details: LaunchDetails = {
    facingDeg: launch.facingDeg,
    windArcHalfWidthDeg: launch.windArcHalfWidthDeg,
    windMinMph: launch.windMinMph,
    windMaxMph: launch.windMaxMph,
    gustMaxMph: launch.gustMaxMph,
    region: launch.region,
    notes: launch.notes,
  };
  const nextSites = mode === "create" ? [...sites.sites, site] : sites.sites.map((s) => (s.slug === site.slug ? site : s));
  return {
    sites: { ...sites, sites: nextSites },
    launches: { ...launches, launches: { ...launches.launches, [launch.slug]: details } },
  };
}

/** Serializes a data file the way the repository stores it (2-space JSON, trailing newline). */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
