// Launches whose sunlight map covers an area of their own instead of the
// square of DEFAULT_RADIUS_KM around them: a whole mountain range, say, for a
// launch pilots fly cross-country from. Listed in forecasts/sunlight-areas.json:
//
//   { "schemaVersion": 1, "areas": { "<slug>": { "name": "Lost River Range",
//       "south": 43.58, "west": -114.35, "north": 44.6, "east": -113.05 } } }
//
// A larger area costs build time and bucket space in proportion (the Lost
// River Range is about 12 times the default square: ~22 minutes, ~700 MB of
// tiles, under 1 GB of memory).

export const SCHEMA_VERSION = 1;
/** Largest side an area may have, km: past this a build no longer fits a workflow run. */
export const MAX_SIDE_KM = 160;

const KM_PER_DEG = 111.32;

/** Side lengths of an area in km (east-west at its middle latitude). */
export function areaSizeKm({ south, west, north, east }) {
  return {
    eastWest: (east - west) * KM_PER_DEG * Math.cos((((south + north) / 2) * Math.PI) / 180),
    northSouth: (north - south) * KM_PER_DEG,
  };
}

/** Problems with the areas file, given the launches in sites.json. */
export function areaErrors(doc, sites) {
  const errors = [];
  if (doc?.schemaVersion !== SCHEMA_VERSION) return [`schemaVersion must be ${SCHEMA_VERSION}`];
  const bySlug = new Map(sites.map((s) => [s.slug, s]));
  for (const [slug, area] of Object.entries(doc.areas ?? {})) {
    const label = `"${slug}"`;
    const site = bySlug.get(slug);
    if (!site) {
      errors.push(`${label}: has a sunlight area but is not in sites.json`);
      continue;
    }
    const keys = Object.keys(area ?? {}).sort().join(",");
    if (keys !== "east,name,north,south,west") {
      errors.push(`${label}: an area has exactly name, south, west, north and east`);
      continue;
    }
    const { name, south, west, north, east } = area;
    if (typeof name !== "string" || name.trim() === "") errors.push(`${label}: the area needs a name`);
    if (![south, west, north, east].every(Number.isFinite)) {
      errors.push(`${label}: south, west, north and east must be numbers`);
      continue;
    }
    if (!(south < north && west < east)) errors.push(`${label}: south must be below north and west left of east`);
    if (!(site.latitude > south && site.latitude < north && site.longitude > west && site.longitude < east)) {
      errors.push(`${label}: the launch is outside its sunlight area`);
    }
    const size = areaSizeKm(area);
    if (size.eastWest > MAX_SIDE_KM || size.northSouth > MAX_SIDE_KM) {
      errors.push(`${label}: the area is ${Math.round(size.eastWest)} x ${Math.round(size.northSouth)} km; at most ${MAX_SIDE_KM} km a side`);
    }
  }
  return errors;
}

/** The areas by slug, as the builder uses them (no validation; see areaErrors). */
export function parseAreas(doc) {
  if (doc?.schemaVersion !== SCHEMA_VERSION) throw new Error(`sunlight-areas.json: schemaVersion must be ${SCHEMA_VERSION}`);
  return Object.fromEntries(
    Object.entries(doc.areas ?? {}).map(([slug, a]) => [slug, { name: a.name, south: a.south, west: a.west, north: a.north, east: a.east }]),
  );
}
