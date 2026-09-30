import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  AZIMUTHS_DEG, BLOCK_PX, HORIZON_BORDER, HORIZON_CELLS, HORIZON_STEP_DEG, MAX_ZOOM, MIN_ZOOM, RELIEF_VERSION, RELIEF_ZOOM, TILE_BYTES, TILE_SIZE,
  blocksOf, buildRelief, buildSolarTerrain, decodeRelief, deltaDecode, deltaEncode, domainFor, domainForBounds, gridFromFunction, halveLevel, indexIsFresh,
  latToY, lonToX, reliefIsFresh, reliefZoomFor, startSolarTerrain,
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

test("the relief covers the square corner to corner and decodes to the elevation", () => {
  const elevation = (lat, lon) => {
    const p = local(lat, lon);
    return 1300 + 0.3 * p.east - 0.2 * p.north + 60 * Math.sin(p.east / 400) * Math.cos(p.north / 300);
  };
  const { fine, coarse } = grids(elevation, { radiusKm: 1, maxDistanceKm: 2 });
  const sources = { surface: { id: "synthetic-fine" }, horizon: { id: "synthetic-coarse" } };
  const site = { slug: "cervidae-peak", latitude: LAT, longitude: LON };
  const { index, relief } = buildSolarTerrain(site, { fine, coarse, sources, radiusKm: 1, maxDistanceKm: 2 });
  const meta = index.relief;
  assert.equal(meta.version, RELIEF_VERSION);
  assert.equal(meta.path, `${index.generation}/relief-v${RELIEF_VERSION}.bin.gz`);
  assert.ok(reliefIsFresh(index));
  assert.ok(!reliefIsFresh({ ...index, relief: undefined }));

  // Corners of the zoom-11 pixels spanning exactly the zoom-14 square.
  const d = domainFor(LAT, LON, 1);
  const f = 2 ** (MAX_ZOOM - RELIEF_ZOOM);
  assert.equal(meta.x0 * f, d.x0);
  assert.equal((meta.x0 + meta.width - 1) * f, d.x1);
  assert.equal((meta.y0 + meta.height - 1) * f, d.y1);

  const heights = decodeRelief(gunzipSync(relief.body), meta);
  assert.equal(heights.length, meta.width * meta.height);
  for (const [i, j] of [[0, 0], [meta.width - 1, meta.height - 1], [3, 2]]) {
    const expected = elevation(yToLat(meta.y0 + j, RELIEF_ZOOM), xToLon(meta.x0 + i, RELIEF_ZOOM));
    assert.ok(Math.abs(heights[j * meta.width + i] - expected) < 0.6, `(${i}, ${j}) ${heights[j * meta.width + i]} vs ${expected}`);
  }
  assert.ok(meta.minM < meta.maxM);

  // Points without data decode as NaN; low ground and a steep drop survive the delta filter.
  const holes = buildRelief({ ...fine, values: fine.values.map((v, k) => (k % 7 === 0 ? Number.NaN : v - 1700)) }, d, "g");
  const decoded = decodeRelief(gunzipSync(holes.body), holes.meta);
  assert.ok(decoded.some((v) => Number.isNaN(v)));
  assert.ok(decoded.some((v) => v < -300));
});

test("blocks cover a large area exactly, and no tile of any zoom spans two blocks", () => {
  assert.equal(BLOCK_PX % (TILE_SIZE * 2 ** (MAX_ZOOM - MIN_ZOOM)), 0);
  const domain = domainForBounds({ south: 43.58, west: -114.35, north: 44.6, east: -113.05 });
  const blocks = blocksOf(domain);
  assert.ok(blocks.length > 9);
  let area = 0;
  for (const b of blocks) {
    assert.ok(b.x0 >= domain.x0 && b.x1 <= domain.x1 && b.y0 >= domain.y0 && b.y1 <= domain.y1);
    for (const [edge, domainEdge] of [[b.x0, domain.x0], [b.x1, domain.x1], [b.y0, domain.y0], [b.y1, domain.y1]]) {
      assert.ok(edge === domainEdge || edge % BLOCK_PX === 0, "a block edge is the domain's or on the block grid");
    }
    area += (b.x1 - b.x0) * (b.y1 - b.y0);
  }
  assert.equal(area, (domain.x1 - domain.x0) * (domain.y1 - domain.y0));
});

/** A small area around the corner where four blocks meet, near the reference point. */
function cornerArea(halfKm) {
  const X = Math.round(lonToX(LON, MAX_ZOOM) / BLOCK_PX) * BLOCK_PX;
  const Y = Math.round(latToY(LAT, MAX_ZOOM) / BLOCK_PX) * BLOCK_PX;
  const lat = yToLat(Y, MAX_ZOOM);
  const lon = xToLon(X, MAX_ZOOM);
  const k = metresPerDegree(lat);
  return {
    site: { slug: "corner", latitude: lat + 0.0003, longitude: lon + 0.0004 },
    area: { name: "Corner", south: lat - (halfKm * 1000) / k.lat, west: lon - (halfKm * 1000) / k.lon, north: lat + (halfKm * 1000) / k.lat, east: lon + (halfKm * 1000) / k.lon },
  };
}

test("an area built block by block gets exactly the tiles and relief it gets in one go", () => {
  const { site, area } = cornerArea(1.5);
  const elevation = (lat, lon) => 1500 + 400 * Math.sin((lat - LAT) * 900) * Math.cos((lon - LON) * 700);
  const b = domainForBounds(area).bounds;
  const pad = 2600;
  const box = (p, res) => ({ south: b.south - p / m.lat, north: b.north + p / m.lat, west: b.west - p / m.lon, east: b.east + p / m.lon, dLon: res, dLat: res });
  const fine = gridFromFunction(elevation, box(300, 1 / 10800));
  const coarse = gridFromFunction(elevation, box(pad, 1 / 3600));
  const options = { coarse, sources: { surface: { id: "f" }, horizon: { id: "c" } }, area, maxDistanceKm: 2 };

  const byBlocks = buildSolarTerrain(site, { fine, ...options, generatedAt: "t" });
  assert.equal(startSolarTerrain(site, options).blocks.length, 4);
  const whole = startSolarTerrain(site, options);
  const tiles = whole.addBlock(whole.domain, fine); // the whole domain as one block: the one-go build
  whole.blocks.splice(0, whole.blocks.length, whole.domain);
  const oneGo = { ...whole.finish({ generatedAt: "t" }), tiles };

  const key = (t) => `${t.z}/${t.x}/${t.y}`;
  const sorted = (list) => [...list].sort((p, q) => key(p).localeCompare(key(q)));
  assert.deepEqual(sorted(byBlocks.tiles).map(key), sorted(oneGo.tiles).map(key));
  sorted(byBlocks.tiles).forEach((t, i) => assert.ok(t.body.equals(sorted(oneGo.tiles)[i].body), `tile ${key(t)}`));
  assert.ok(byBlocks.relief.body.equals(oneGo.relief.body));
  assert.deepEqual(byBlocks.index, oneGo.index);
});

test("a launch's own area replaces the square around it", () => {
  const { site, area } = cornerArea(1.5);
  const elevation = (lat, lon) => 1500 + 0.2 * (lat - LAT) * m.lat;
  const b = domainForBounds(area).bounds;
  const box = (p, res) => ({ south: b.south - p / m.lat, north: b.north + p / m.lat, west: b.west - p / m.lon, east: b.east + p / m.lon, dLon: res, dLat: res });
  const fine = gridFromFunction(elevation, box(300, 1 / 10800));
  const coarse = gridFromFunction(elevation, box(2600, 1 / 3600));
  const sources = { surface: { id: "f" }, horizon: { id: "c" } };
  const { index } = buildSolarTerrain(site, { fine, coarse, sources, area, maxDistanceKm: 2 });
  assert.deepEqual(index.inputs.area, area);
  assert.equal(index.inputs.radiusKm, undefined);
  assert.ok(index.bounds.south <= area.south && index.bounds.north >= area.north && index.bounds.west <= area.west && index.bounds.east >= area.east);

  assert.ok(indexIsFresh(index, site, { area, maxDistanceKm: 2 }));
  assert.ok(!indexIsFresh(index, site, { area: { ...area, north: area.north + 0.01 }, maxDistanceKm: 2 }));
  assert.ok(!indexIsFresh(index, site, { maxDistanceKm: 2 }), "dropping the area rebuilds the square");
  assert.throws(() => startSolarTerrain({ ...site, latitude: area.north + 0.05 }, { coarse, sources, area }), /outside its sunlight area/);
});

test("the relief drops to a coarser zoom only for a large area", () => {
  assert.equal(reliefZoomFor(domainFor(LAT, LON, 15)), RELIEF_ZOOM);
  const range = domainForBounds({ south: 43.58, west: -114.35, north: 44.6, east: -113.05 });
  const z = reliefZoomFor(range);
  assert.equal(z, RELIEF_ZOOM - 1);
  assert.ok(Math.max(range.x1 - range.x0, range.y1 - range.y0) / 2 ** (MAX_ZOOM - z) < 1200);
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
  const domain = domainFor(LAT, LON, 1);
  const [block] = blocksOf(domain);
  const terrain = await readTerrain(domain, { slug: "cervidae-peak", maxDistanceKm: 20, open });
  assert.equal(terrain.sources.surface.id, "usgs-3dep-13");
  assert.equal(terrain.sources.horizon.id, "usgs-3dep-1");
  assert.ok(opened.some((u) => u.includes("n44w117")), "the coarse window crosses 116°W");
  const fine = await terrain.readFine(block);
  for (const grid of [fine, terrain.coarse]) {
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
  const fallback = await readTerrain(domain, { slug: "cervidae-peak", maxDistanceKm: 5, open: glo, warn: (m) => warnings.push(m) });
  assert.equal(fallback.sources.surface.id, "copernicus-glo30");
  assert.match(warnings[0], /^WARN cervidae-peak: USGS 3DEP unavailable/);
  assert.ok(Math.abs(sampleGrid(await fallback.readFine(block), LAT, LON) - elevation(LAT, LON)) < 0.05);
});
