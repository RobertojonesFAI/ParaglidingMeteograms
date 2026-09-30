import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  AZIMUTHS_DEG, HORIZON_BORDER, HORIZON_CELLS, HORIZON_STEP_DEG, MAX_ZOOM, MIN_ZOOM, TILE_BYTES, TILE_SIZE,
  buildSolarTerrain, deltaDecode, deltaEncode, domainFor, gridFromFunction, halveLevel, indexIsFresh, latToY, lonToX,
  metresPerDegree, metresPerPixel, rayDistances, sampleGrid, skyViewFactor, surfaceLevel, traceHorizons, xToLon, yToLat,
} from "./solar.mjs";
import { usgsUrl } from "../solar.mjs";

const LAT = 43.62332;
const LON = -115.98076;
const m = metresPerDegree(LAT);
const DEG = Math.PI / 180;

/** Local metres east/north of the reference point. */
const local = (lat, lon) => ({ east: (lon - LON) * m.lon, north: (lat - LAT) * m.lat });

function grids(elevation, { radiusKm, maxDistanceKm, fineRes = 1 / 10800, coarseRes = 1 / 3600 }) {
  const d = domainFor(LAT, LON, radiusKm).bounds;
  const pad = (maxDistanceKm * 1000 + 600) / m.lat;
  const padLon = (maxDistanceKm * 1000 + 600) / m.lon;
  return {
    fine: gridFromFunction(elevation, { south: d.south - 0.002, north: d.north + 0.002, west: d.west - 0.003, east: d.east + 0.003, dLon: fineRes, dLat: fineRes }),
    coarse: gridFromFunction(elevation, { south: d.south - pad, north: d.north + pad, west: d.west - padLon, east: d.east + padLon, dLon: coarseRes, dLat: coarseRes }),
  };
}

test("Web Mercator conversions round-trip and match the known pixel size", () => {
  for (const z of [11, 14]) {
    assert.ok(Math.abs(yToLat(latToY(LAT, z), z) - LAT) < 1e-9);
    assert.ok(Math.abs(xToLon(lonToX(LON, z), z) - LON) < 1e-9);
  }
  assert.ok(Math.abs(metresPerPixel(LAT, 14) - 6.92) < 0.01);
});

test("the domain is a whole number of zoom-14 tiles around the launch", () => {
  const d = domainFor(LAT, LON, 15);
  assert.equal(d.x0 % TILE_SIZE, 0);
  assert.equal(d.y1 % TILE_SIZE, 0);
  const cx = lonToX(LON, MAX_ZOOM);
  const r = 15000 / metresPerPixel(LAT, MAX_ZOOM);
  assert.ok(d.x0 <= cx - r && d.x1 >= cx + r && d.y0 <= latToY(LAT, MAX_ZOOM) - r);
  assert.ok(d.bounds.north > LAT + 0.13 && d.bounds.south < LAT - 0.13);
});

test("surface normals recover a plane's slope and aspect", () => {
  // 25° slope facing north-west (terrain descends toward 315°).
  const slope = 25;
  const aspect = 315;
  const dirE = Math.sin(aspect * DEG);
  const dirN = Math.cos(aspect * DEG);
  const elevation = (lat, lon) => {
    const p = local(lat, lon);
    return 1500 - Math.tan(slope * DEG) * (p.east * dirE + p.north * dirN);
  };
  const { fine } = grids(elevation, { radiusKm: 0.4, maxDistanceKm: 0 });
  const { level } = surfaceLevel(fine, domainFor(LAT, LON, 0.4));
  const o = Math.floor(level.height / 2) * level.width + Math.floor(level.width / 2);
  const gotSlope = Math.acos(level.nz[o]) / DEG;
  const gotAspect = (Math.atan2(level.nx[o], level.ny[o]) / DEG + 360) % 360;
  assert.ok(Math.abs(gotSlope - slope) < 0.3, `slope ${gotSlope}`);
  assert.ok(Math.abs(gotAspect - aspect) < 0.5, `aspect ${gotAspect}`);
  assert.ok(Math.abs(Math.hypot(level.nx[o], level.ny[o], level.nz[o]) - 1) < 1e-6);
});

test("the ray steps are dense near the cell and reach the full distance", () => {
  const d = rayDistances(20000);
  assert.equal(d[0], 25);
  assert.equal(d[1] - d[0], 25);
  assert.ok(d.at(-1) > 19000 && d.at(-1) <= 20000);
  assert.ok(d.length < 220);
});

test("horizons see a ridge at its true angle, and flat ground as an open horizon", () => {
  // Flat valley at 1000 m with a broad north-south ridge 200 m high, 1 km east.
  const ridge = (east) => 200 * Math.exp(-(((east - 1000) / 200) ** 2));
  const elevation = (lat, lon) => 1000 + ridge(local(lat, lon).east);
  const { coarse } = grids(elevation, { radiusKm: 0.3, maxDistanceKm: 3 });
  const grid = traceHorizons(coarse, domainFor(LAT, LON, 0.3), { maxDistanceM: 3000 });
  const i = Math.floor(lonToX(LON, 12) - 0.5) - grid.x0;
  const j = Math.floor(latToY(LAT, 12) - 0.5) - grid.y0;
  const o = j * grid.width + i;
  const cellEast = local(yToLat(grid.y0 + j + 0.5, 12), xToLon(grid.x0 + i + 0.5, 12)).east;
  // Exact answer: the steepest sight line along each ray, sampled every metre.
  const exact = (az) => {
    let best = 0;
    for (let d = 1; d < 3000; d += 1) best = Math.max(best, Math.atan((ridge(cellEast + d * Math.sin(az * DEG)) - (d * d * 0.87) / (2 * 6371008.8)) / d));
    return best / DEG;
  };
  for (const az of [60, 80, 100, 120]) {
    const got = grid.horizons[AZIMUTHS_DEG.indexOf(az)][o];
    assert.ok(Math.abs(got - exact(az)) < 0.15, `azimuth ${az}: ${got} vs ${exact(az)}`);
  }
  for (const az of [180, 220, 260, 300, 340, 0]) assert.equal(grid.horizons[AZIMUTHS_DEG.indexOf(az)][o], 0, `azimuth ${az}`);
});

test("far terrain drops below the horizon with the earth's curvature", () => {
  // Drop with standard refraction at 15 km: 15000^2 * 0.87 / (2 R) = 15.4 m.
  const horizonNorth = (plateauM) => {
    const elevation = (lat, lon) => (local(lat, lon).north > 15000 ? 1000 + plateauM : 1000);
    const { coarse } = grids(elevation, { radiusKm: 0.2, maxDistanceKm: 20 });
    const grid = traceHorizons(coarse, domainFor(LAT, LON, 0.2), { maxDistanceM: 20000 });
    return grid.horizons[0][Math.floor(grid.height / 2) * grid.width + Math.floor(grid.width / 2)];
  };
  assert.equal(horizonNorth(10), 0);
  const raised = horizonNorth(60);
  assert.ok(raised > 0.15 && raised < Math.atan(60 / 15000) / DEG, `60 m plateau: ${raised}`);
});

test("sky-view factor: open flat ground, an open slope, and a uniform horizon", () => {
  const zeros = AZIMUTHS_DEG.map(() => 0);
  assert.ok(Math.abs(skyViewFactor(0, 0, 1, zeros) - 1) < 1e-9);
  for (const slope of [10, 30, 60]) {
    const s = slope * DEG;
    const v = skyViewFactor(Math.sin(s) * Math.sin(1), Math.sin(s) * Math.cos(1), Math.cos(s), zeros);
    assert.ok(Math.abs(v - (1 + Math.cos(s)) / 2) < 0.006, `slope ${slope}: ${v}`);
  }
  const ring = AZIMUTHS_DEG.map(() => 30);
  assert.ok(Math.abs(skyViewFactor(0, 0, 1, ring) - Math.cos(30 * DEG) ** 2) < 1e-9);
});

test("the row-delta filter round-trips", () => {
  const plane = Uint8Array.from({ length: 64 * 5 }, (_, i) => (i * 37 + (i >> 3)) & 255);
  assert.deepEqual(deltaDecode(deltaEncode(plane, 64), 64), plane);
});

test("halving a level averages the normals of its children", () => {
  const level = {
    z: 14, x0: 0, y0: 0, width: 2, height: 2,
    nx: Float32Array.from([0.5, -0.5, 0.5, Number.NaN]),
    ny: Float32Array.from([0, 0, 0, Number.NaN]),
    nz: Float32Array.from([0.866, 0.866, 0.866, Number.NaN]),
    svf: Float32Array.from([0.9, 0.8, 0.7, Number.NaN]),
  };
  const half = halveLevel(level);
  assert.equal(half.width, 1);
  assert.ok(Math.abs(half.nx[0] - 0.5 / 3) < 1e-6);
  assert.ok(Math.abs(half.svf[0] - 0.8) < 1e-6);
});

test("a full build has every zoom, a stable generation and a readable launch summary", () => {
  const elevation = (lat, lon) => {
    const p = local(lat, lon);
    return 1300 + 0.3 * p.east - 0.2 * p.north + 60 * Math.sin(p.east / 400) * Math.cos(p.north / 300);
  };
  const { fine, coarse } = grids(elevation, { radiusKm: 1, maxDistanceKm: 2 });
  const sources = { surface: { id: "synthetic-fine" }, horizon: { id: "synthetic-coarse" } };
  const site = { slug: "cervidae-peak", latitude: LAT, longitude: LON };
  const { index, tiles } = buildSolarTerrain(site, { fine, coarse, sources, radiusKm: 1, maxDistanceKm: 2, generatedAt: "2026-09-30T00:00:00Z" });

  assert.deepEqual(Object.keys(index.tiles.ranges).map(Number), [11, 12, 13, 14]);
  assert.equal(index.tiles.minZoom, MIN_ZOOM);
  assert.equal(index.tiles.count, tiles.length);
  for (const z of [11, 12, 13, 14]) assert.ok(tiles.some((t) => t.z === z), `zoom ${z}`);
  assert.match(index.tiles.path, /^[0-9a-f]{12}\/\{z\}\/\{x\}\/\{y\}\.bin\.gz$/);
  assert.equal(index.encoding.horizonCells, HORIZON_CELLS);
  assert.equal(index.encoding.horizonBorder, HORIZON_BORDER);
  assert.equal(index.encoding.horizonStepDeg, HORIZON_STEP_DEG);

  const raw = gunzipSync(tiles.find((t) => t.z === 14).body);
  assert.equal(raw.length, TILE_BYTES);

  // Plane z = 1300 + 0.3 e - 0.2 n plus ripples: overall facing is west-north-west, uphill east.
  assert.ok(index.launch.slopeDeg > 5 && index.launch.slopeDeg < 35, `slope ${index.launch.slopeDeg}`);
  assert.ok(Math.abs(index.launch.elevationM - elevation(LAT, LON)) < 1);
  assert.equal(index.launch.horizonDeg.length, AZIMUTHS_DEG.length);

  const again = buildSolarTerrain(site, { fine, coarse, sources, radiusKm: 1, maxDistanceKm: 2 });
  assert.equal(again.index.generation, index.generation);
  const moved = buildSolarTerrain({ ...site, latitude: LAT + 0.001 }, { fine, coarse, sources, radiusKm: 1, maxDistanceKm: 2 });
  assert.notEqual(moved.index.generation, index.generation);

  assert.ok(indexIsFresh(index, site, { radiusKm: 1, maxDistanceKm: 2 }));
  assert.ok(!indexIsFresh(index, { ...site, longitude: LON + 0.01 }, { radiusKm: 1, maxDistanceKm: 2 }));
  assert.ok(!indexIsFresh(index, site, { radiusKm: 15, maxDistanceKm: 2 }));
  assert.ok(!indexIsFresh(null, site, {}));
});

test("grid sampling is bilinear and refuses points outside the grid", () => {
  const grid = gridFromFunction((lat, lon) => lat * 100 + lon, { south: 43, north: 43.01, west: -116, east: -115.99, dLon: 0.001, dLat: 0.001 });
  assert.ok(Math.abs(sampleGrid(grid, 43.0052, -115.9973) - (4300.52 - 115.9973)) < 1e-3);
  assert.ok(Number.isNaN(sampleGrid(grid, 42.9, -116)));
});

test("USGS tile names follow the 3DEP staged-product scheme", () => {
  assert.match(usgsUrl("13", 43.62, -115.98), /\/13\/TIFF\/current\/n44w116\/USGS_13_n44w116\.tif$/);
  assert.match(usgsUrl("1", 43.62, -116.2), /\/1\/TIFF\/current\/n44w117\/USGS_1_n44w117\.tif$/);
  assert.match(usgsUrl("13", 44.5, -71.2), /n45w072/);
  assert.equal(usgsUrl("13", 46.5, 7.9), null);
});

test("reads both elevation models across USGS tile edges, and falls back to GLO-30 outside 3DEP", async () => {
  const { readTerrain } = await import("../solar.mjs");
  const elevation = (lat, lon) => 1200 + 3000 * (lat - 43.6) - 2000 * (lon + 116);
  // Tiles shaped like the real products: 1°, 6-pixel overlap, rounded pixel size.
  const opened = [];
  const open = async (url) => {
    opened.push(url);
    const usgs = url.match(/USGS_(13|1)_n(\d+)w(\d+)\.tif$/);
    if (!usgs) throw new Error(`unexpected ${url}`);
    const perDeg = usgs[1] === "13" ? 10800 : 3600;
    const res = usgs[1] === "13" ? 9.259259269220167e-5 : 2.777777777999431e-4;
    const west = -Number(usgs[3]) - 6 / perDeg;
    const north = Number(usgs[2]) + 6 / perDeg;
    const size = perDeg + 12;
    return {
      width: size, height: size, transform: [res, 0, west, 0, -res, north], nodata: -999999, epsg: 4269,
      async readWindow(col0, row0, cols, rows) {
        const out = new Float32Array(cols * rows);
        for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) out[r * cols + c] = elevation(north - (row0 + r + 0.5) * res, west + (col0 + c + 0.5) * res);
        return out;
      },
    };
  };
  const site = { slug: "cervidae-peak", latitude: LAT, longitude: LON };
  const terrain = await readTerrain(site, { radiusKm: 1, maxDistanceKm: 20, open });
  assert.equal(terrain.sources.surface.id, "usgs-3dep-13");
  assert.equal(terrain.sources.horizon.id, "usgs-3dep-1");
  assert.ok(opened.some((u) => u.includes("n44w117")), "the coarse window crosses 116°W");
  for (const grid of [terrain.fine, terrain.coarse]) {
    for (const [lat, lon] of [[LAT, LON], [LAT + 0.004, LON - 0.006]]) {
      assert.ok(Math.abs(sampleGrid(grid, lat, lon) - elevation(lat, lon)) < 0.05);
    }
  }
  const coarseWest = terrain.coarse.west;
  assert.ok(coarseWest < -116.2 && terrain.coarse.west + terrain.coarse.width * terrain.coarse.dLon > -115.75);

  const warnings = [];
  const glo = async (url) => {
    if (url.includes("USGS")) throw new Error("403");
    const g = url.match(/N(\d+)_00_W(\d+)_00/);
    const res = 1 / 3600;
    const west = -Number(g[2]);
    const north = Number(g[1]) + 1;
    return {
      width: 3600, height: 3600, transform: [res, 0, west, 0, -res, north], nodata: null, epsg: 4326,
      async readWindow(col0, row0, cols, rows) {
        const out = new Float32Array(cols * rows);
        for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) out[r * cols + c] = elevation(north - (row0 + r + 0.5) * res, west + (col0 + c + 0.5) * res);
        return out;
      },
    };
  };
  const fallback = await readTerrain(site, { radiusKm: 1, maxDistanceKm: 5, open: glo, warn: (m) => warnings.push(m) });
  assert.equal(fallback.sources.surface.id, "copernicus-glo30");
  assert.match(warnings[0], /^WARN cervidae-peak: USGS 3DEP unavailable/);
  assert.ok(Math.abs(sampleGrid(fallback.fine, LAT, LON) - elevation(LAT, LON)) < 0.05);
});
