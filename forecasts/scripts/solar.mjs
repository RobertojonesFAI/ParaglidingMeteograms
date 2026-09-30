// Builds the terrain tiles behind each launch page's sunlight map, and the
// relief its 3D view is drawn on (scripts/lib/solar.mjs explains both), and,
// with --sync, publishes them to the bucket for every launch whose published
// tiles are missing or were built from different inputs. When only the relief
// is missing or outdated, just the relief is built and added.
//
// Each launch gets the square of --radius-km around it, unless it has its own
// area in sunlight-areas.json (a mountain range, say). A large area is built in
// blocks of ~28 km, reading the fine elevation one block at a time.
//
// Elevation sources (read over HTTP, only the windows needed):
//   surface   USGS 3DEP 1/3 arc-second (~10 m)
//   horizons  USGS 3DEP 1 arc-second (~30 m), covering 20 km around the area
// Outside 3DEP's coverage both fall back to Copernicus GLO-30 (30 m).
//
// Usage:
//   node scripts/solar.mjs --sync                                   bucket mode (same variables as the engine)
//   node scripts/solar.mjs --output out [--sites sites.json] [--areas sunlight-areas.json] [--slug cervidae-peak] [--radius-km 15]
//   --ignore-areas   every launch gets the --radius-km square (the quick check on pull requests)

import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSites } from "@azohra/meteo.forecast";
import { bucketFromEnv } from "./lib/bucket.mjs";
import { mosaic, tilesAround } from "./lib/mosaic.mjs";
import { DEFAULT_MAX_DISTANCE_KM, DEFAULT_RADIUS_KM, FINE_MARGIN_M, blocksOf, domainOf, encodeRelief, expandBounds, fillRelief, indexIsFresh, reliefFrame, reliefIsFresh, startSolarTerrain } from "./lib/solar.mjs";
import { parseAreas } from "./lib/sunlight-areas.mjs";

const engineDir = dirname(createRequire(import.meta.url).resolve("@azohra/meteo.forecast/package.json"));
const T = await import(pathToFileURL(join(engineDir, "dist/terrain.js")).href);

const TNM = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation";

/** USGS 3DEP staged 1° tile covering a point ("13" = 1/3 arc-second, "1" = 1 arc-second); null outside its naming scheme. */
export function usgsUrl(product, lat, lon) {
  if (!(lat >= 0 && lon < 0)) return null;
  const id = `n${Math.floor(lat) + 1}w${String(Math.floor(-lon) + 1).padStart(3, "0")}`;
  return `${TNM}/${product}/TIFF/current/${id}/USGS_${product}_${id}.tif`;
}

export const SOURCES = {
  usgs13: {
    id: "usgs-3dep-13",
    name: "USGS 3DEP 1/3 arc-second DEM",
    resolutionM: 10,
    licence: "Public domain",
    url: "https://www.usgs.gov/3d-elevation-program",
    urlOf: (lat, lon) => usgsUrl("13", lat, lon),
  },
  usgs1: {
    id: "usgs-3dep-1",
    name: "USGS 3DEP 1 arc-second DEM",
    resolutionM: 30,
    licence: "Public domain",
    url: "https://www.usgs.gov/3d-elevation-program",
    urlOf: (lat, lon) => usgsUrl("1", lat, lon),
  },
  glo30: {
    id: "copernicus-glo30",
    name: "Copernicus DEM GLO-30",
    resolutionM: 30,
    licence: "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
    url: "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
    urlOf: (lat, lon) => T.glo30Url(lat, lon),
  },
};

const publicSource = ({ urlOf, ...rest }) => rest;

/** Reads the elevation inside `bounds` from a tiled source as a Grid (NaN = no data). */
export async function readGrid(source, bounds, { open = T.openCog, log = () => {} } = {}) {
  const lat = (bounds.south + bounds.north) / 2;
  const lon = (bounds.west + bounds.east) / 2;
  const urls = tilesAround(source.urlOf, lat, lon, (bounds.north - bounds.south) / 2, (bounds.east - bounds.west) / 2);
  if (urls.some((u) => u === null)) throw new Error(`${source.name} has no tiles here`);
  const tiles = await Promise.all(urls.map((u) => open(u)));
  const ds = mosaic(tiles);
  const [a, , c, , e, f] = ds.transform;
  const col0 = Math.max(0, Math.floor((bounds.west - c) / a));
  const col1 = Math.min(ds.width, Math.ceil((bounds.east - c) / a));
  const row0 = Math.max(0, Math.floor((bounds.north - f) / e));
  const row1 = Math.min(ds.height, Math.ceil((bounds.south - f) / e));
  const width = col1 - col0;
  const height = row1 - row0;
  log(`  ${source.name}: ${urls.length} tile(s), window ${width} x ${height}`);
  const raw = await ds.readWindow(col0, row0, width, height);
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i += 1) {
    const v = raw[i];
    values[i] = v === ds.nodata || !(v > -1000 && v < 9000) ? Number.NaN : v;
  }
  return { values, width, height, west: c + col0 * a, north: f + row0 * e, dLon: a, dLat: -e };
}

/**
 * Opens both elevation models for a launch's domain, preferring 3DEP: reads
 * the coarse one (the domain and the terrain that can shade it) and returns
 * `readFine(block)` for the fine one, read one block at a time.
 */
export async function readTerrain(domain, { slug, maxDistanceKm, open, log = () => {}, warn = () => {} }) {
  const coarseBounds = expandBounds(domain.bounds, maxDistanceKm * 1000 + 500);
  const firstBlock = blocksOf(domain)[0];
  const opened = (fineSource, coarseSource, first, coarse) => ({
    coarse,
    sources: { surface: publicSource(fineSource), horizon: publicSource(coarseSource) },
    // The first block was read to check the source; hand it out once instead of reading it again.
    readFine: async (block) => {
      if (first && block.x0 === firstBlock.x0 && block.y0 === firstBlock.y0) {
        const grid = first;
        first = null;
        return grid;
      }
      return withRetries(() => readGrid(fineSource, expandBounds(block.bounds, FINE_MARGIN_M), { open, log }), { warn });
    },
  });
  try {
    const first = await readGrid(SOURCES.usgs13, expandBounds(firstBlock.bounds, FINE_MARGIN_M), { open, log });
    const coarse = await readGrid(SOURCES.usgs1, coarseBounds, { open, log });
    return opened(SOURCES.usgs13, SOURCES.usgs1, first, coarse);
  } catch (error) {
    warn(`WARN ${slug}: USGS 3DEP unavailable (${error.message}); using Copernicus GLO-30 (30 m) instead`);
    const coarse = await readGrid(SOURCES.glo30, coarseBounds, { open, log });
    return opened(SOURCES.glo30, SOURCES.glo30, null, coarse);
  }
}

/** Retries a network read a few times: a large area makes many of them, and a rare one fails. */
async function withRetries(read, { attempts = 3, warn = () => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts) throw error;
      warn(`  read failed (${error.message}); retrying (${attempt}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function main() {
  const { values } = parseArgs({
    options: {
      sync: { type: "boolean", default: false },
      sites: { type: "string", default: "sites.json" },
      areas: { type: "string", default: "sunlight-areas.json" },
      "ignore-areas": { type: "boolean", default: false },
      output: { type: "string" },
      slug: { type: "string" },
      force: { type: "boolean", default: false },
      "radius-km": { type: "string", default: String(DEFAULT_RADIUS_KM) },
      "max-distance-km": { type: "string", default: String(DEFAULT_MAX_DISTANCE_KM) },
    },
  });
  if (!values.sync && !values.output) throw new Error("pass --sync (publish to the bucket) or --output <dir>");
  const radiusKm = Number(values["radius-km"]);
  const maxDistanceKm = Number(values["max-distance-km"]);
  const sites = parseSites(JSON.parse(readFileSync(values.sites, "utf8"))).filter((s) => !values.slug || s.slug === values.slug);
  if (sites.length === 0) throw new Error("no matching launches");
  const areas = values["ignore-areas"] ? {} : parseAreas(JSON.parse(readFileSync(values.areas, "utf8")));
  const bucket = values.sync ? bucketFromEnv() : null;
  const log = (m) => console.log(m);
  const warn = (m) => console.warn(m);
  const summary = [];

  const immutable = { contentType: "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" };
  for (const site of sites) {
    const area = areas[site.slug];
    const domain = domainOf(site, { radiusKm, area });
    const indexKey = `solar/${site.slug}/index.json`;
    if (bucket && !values.force) {
      const existing = await bucket.get(indexKey);
      const published = existing ? JSON.parse(existing.toString("utf8")) : null;
      if (indexIsFresh(published, site, { radiusKm, area, maxDistanceKm })) {
        if (reliefIsFresh(published)) {
          log(`${site.slug}: sunlight terrain is current (${published.generation})`);
          summary.push(`| ${site.name} | current | ${published.tiles.count} | – |`);
          continue;
        }
        // The tiles are current; only the 3D relief is missing. It needs just
        // the surface model the tiles were built from, not the horizons.
        const started = Date.now();
        const source = Object.values(SOURCES).find((s) => s.id === published.sources?.surface?.id) ?? SOURCES.usgs13;
        log(`${site.slug}: adding the 3D relief from ${source.name}`);
        const frame = reliefFrame(domain);
        for (const block of blocksOf(domain)) {
          fillRelief(frame, await withRetries(() => readGrid(source, expandBounds(block.bounds, FINE_MARGIN_M), { log }), { warn }), block);
        }
        const relief = encodeRelief(frame, published.generation);
        await bucket.put(`solar/${site.slug}/${relief.meta.path}`, relief.body, immutable);
        await bucket.put(indexKey, JSON.stringify({ ...published, relief: relief.meta }), { cacheControl: "public, max-age=300" });
        const r = relief.meta;
        console.log(`::notice title=${site.slug} 3D relief::${r.width} x ${r.height} heights, ${r.minM}–${r.maxM} m, ${(r.bytes / 1e3).toFixed(0)} kB`);
        summary.push(`| ${site.name} | relief added | ${published.tiles.count} | ${Math.round((Date.now() - started) / 1000)} s |`);
        continue;
      }
    }

    const started = Date.now();
    log(`${site.slug}: reading elevation${area ? ` for ${area.name}` : ""}`);
    const terrain = await readTerrain(domain, { slug: site.slug, maxDistanceKm, log, warn });
    const build = startSolarTerrain(site, { coarse: terrain.coarse, sources: terrain.sources, radiusKm, area, maxDistanceKm, log });
    const base = bucket ? null : join(values.output, "solar", site.slug);
    let uploaded = 0;
    for (const block of build.blocks) {
      const tiles = build.addBlock(block, await terrain.readFine(block));
      const path = (tile) => `${build.generation}/${tile.z}/${tile.x}/${tile.y}.bin.gz`;
      if (bucket) {
        await inBatches(tiles, 16, async (tile) => {
          await bucket.put(`solar/${site.slug}/${path(tile)}`, tile.body, immutable);
          uploaded += 1;
          if (uploaded % 100 === 0) log(`  uploaded ${uploaded} tiles`);
        });
      } else {
        for (const tile of tiles) {
          mkdirSync(join(base, build.generation, String(tile.z), String(tile.x)), { recursive: true });
          writeFileSync(join(base, path(tile)), tile.body);
        }
      }
    }
    const { index, relief } = build.finish();
    const l = index.launch;
    log(`${site.slug}: launch ${l.elevationM} m, slope ${l.slopeDeg}° facing ${l.aspectDeg}°, sky view ${l.skyViewFactor}; horizon E ${l.horizonDeg[4]}° S ${l.horizonDeg[9]}° W ${l.horizonDeg[13]}°`);
    console.log(`::notice title=${site.slug} sunlight terrain::${area ? `${area.name}; ` : ""}launch ${l.elevationM} m, slope ${l.slopeDeg} deg facing ${l.aspectDeg} deg, sky view ${l.skyViewFactor}, horizons (every 20 deg from N) ${l.horizonDeg.join(" ")}; ${index.tiles.count} tiles, ${(index.tiles.bytes / 1e6).toFixed(1)} MB; relief ${index.relief.width} x ${index.relief.height}, ${index.relief.minM}–${index.relief.maxM} m`);

    if (bucket) {
      await bucket.put(`solar/${site.slug}/${index.relief.path}`, relief.body, immutable);
      // The index goes last: readers only find tiles that are already there.
      await bucket.put(indexKey, JSON.stringify(index), { cacheControl: "public, max-age=300" });
    } else {
      writeFileSync(join(base, index.relief.path), relief.body);
      writeFileSync(join(base, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    log(`${site.slug}: ${bucket ? "published" : "written"} in ${seconds} s`);
    summary.push(`| ${site.name} | ${bucket ? "published" : "written"} | ${index.tiles.count} | ${seconds} s |`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Sunlight terrain", "", "| Launch | Result | Tiles | Time |", "| --- | --- | --- | --- |", ...summary, ""].join("\n"));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
