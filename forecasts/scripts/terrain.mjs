// Measures each launch's terrain context (site-context.json) and, with
// --sync, keeps the published copy in step with the published sites.json.
//
// This replaces `meteo forecast terrain --sync` for launches near a map-tile
// edge: it runs the engine's own measurement functions (same sources, same
// maths, same document) on tiles joined by scripts/lib/mosaic.mjs, because
// engine 0.6.0 cannot read across a tile edge. Remove it once the engine
// stitches tiles itself.
//
// Usage:
//   node scripts/terrain.mjs --sync                           bucket mode (same variables as the engine)
//   node scripts/terrain.mjs --sites sites.json --output site-context.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSites, roundDocument } from "@azohra/meteo.forecast";
import { parseSiteContextJson, parseSitesCatalogueJson } from "@azohra/meteo.briefing/contract";
import { bucketFromEnv } from "./lib/bucket.mjs";
import { mosaic, tilesAround } from "./lib/mosaic.mjs";

// The engine's terrain module is not part of its public exports; load it by path.
const engineDir = dirname(createRequire(import.meta.url).resolve("@azohra/meteo.forecast/package.json"));
export const engineTerrain = await import(pathToFileURL(join(engineDir, "dist/terrain.js")).href);
const T = engineTerrain;

/**
 * Measures the terrain context for `sites` exactly as the engine does, reading
 * windows that may span several tiles.
 */
export async function measure(sites, { open = T.openCog, fetchImpl = globalThis.fetch, log = console.log, warn = console.error, generatedAt } = {}) {
  const opened = new Map();
  const openOnce = (url) => {
    if (!opened.has(url)) opened.set(url, open(url));
    return opened.get(url);
  };

  async function windowAround(urlOf, site, halfM) {
    const dLat = halfM / T.M_PER_DEG_LAT;
    const dLon = halfM / T.mPerDegLon(site.latitude);
    const centre = urlOf(site.latitude, site.longitude);
    const urls = tilesAround(urlOf, site.latitude, site.longitude, dLat, dLon);
    const results = await Promise.allSettled(urls.map(openOnce));
    const failed = urls.filter((_, i) => results[i].status === "rejected");
    if (failed.includes(centre)) throw results[urls.indexOf(centre)].reason;
    const tiles = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (failed.length > 0) {
      if (tiles[0].nodata === null) throw new Error(`${site.slug}: neighbouring tile(s) unavailable (${failed.join(", ")}) and the source declares no nodata value`);
      warn(`WARN ${site.slug}: neighbouring tile(s) unavailable, treated as no data: ${failed.join(", ")}`);
    }
    if (tiles.length > 1) log(`${site.slug}: joined ${tiles.length} tiles for a ${Math.round(halfM / 1000)} km window`);
    return T.cogWindow(mosaic(tiles), site.latitude, site.longitude, halfM);
  }

  const terrainOf = async (site) => {
    const { window, lats, lons } = await windowAround(T.glo30Url, site, Math.max(...T.RELIEF_RADII_M) + 200);
    return T.terrainFromWindow(window, lats, lons, site);
  };
  const elevationOf = async (site) =>
    T.pickElevation(
      async (url) => T.projectedPoint(await openOnce(url), site.latitude, site.longitude),
      await T.lidarbcUrls(site.latitude, site.longitude, fetchImpl),
    );
  const landCoverOf = async (site) => {
    const { window, lats, lons } = await windowAround(T.worldcoverUrl, site, Math.max(...T.LAND_COVER_RADII_M) + 100);
    return T.landCoverFromWindow(window, lats, lons, site);
  };

  const stamp = generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const document = roundDocument(await T.buildDocument(sites, { terrainOf, elevationOf, landCoverOf, generatedAt: stamp, log, warn }));
  if (parseSiteContextJson(JSON.stringify(document)) === null) throw new Error("the measured site-context.json fails the reader contract");
  return document;
}

/** True when the context has an entry at exactly each catalogued point (the engine's own freshness rule). */
export function contextIsFresh(sites, context) {
  return context !== null && sites.every((site) => {
    const point = context.sites[site.slug]?.point;
    return point !== undefined && point.latitude === site.latitude && point.longitude === site.longitude;
  });
}

const serialize = (document) => Buffer.from(`${JSON.stringify(document, null, 2)}\n`);

async function main() {
  const { values: args } = parseArgs({
    options: { sync: { type: "boolean", default: false }, sites: { type: "string" }, output: { type: "string" } },
  });

  if (args.sync) {
    const bucket = bucketFromEnv();
    const sitesBytes = await bucket.get("sites.json");
    if (sitesBytes === null) throw new Error("no sites.json is published yet; run the publish:sites step first");
    const catalogue = parseSitesCatalogueJson(sitesBytes.toString("utf-8"));
    if (catalogue === null) throw new Error("the published sites.json fails the contract guard");
    const contextBytes = await bucket.get("site-context.json");
    const context = contextBytes === null ? null : parseSiteContextJson(contextBytes.toString("utf-8"));
    if (contextIsFresh(catalogue.sites, context)) {
      console.log("site-context.json is up to date");
      return;
    }
    const document = await measure(catalogue.sites);
    await bucket.put("site-context.json", serialize(document));
    console.log(`Measured terrain for ${catalogue.sites.length} launch(es) and published site-context.json`);
    return;
  }

  if (!args.sites) throw new Error("usage: node scripts/terrain.mjs --sync | --sites sites.json [--output site-context.json]");
  const sitesPath = resolve(args.sites);
  const sites = parseSites(readFileSync(sitesPath, "utf-8"), sitesPath);
  const document = await measure(sites);
  const output = resolve(args.output ?? join(dirname(sitesPath), "site-context.json"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serialize(document));
  console.log(`Wrote terrain context for ${sites.length} launch(es) to ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
