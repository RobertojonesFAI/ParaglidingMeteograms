// Terrain inputs for the sunlight map: everything about the ground that does
// not change with time, so the browser only has to add the sun and the clouds.
//
// For each launch, a square of terrain around it is cut into Web Mercator map
// tiles (zoom 11 to 14; zoom 14 pixels are ~7 m at Boise). Each tile carries,
// per pixel:
//   - the surface normal (which way the ground faces, and how steeply), and
//   - the sky-view factor (how much of the sky the ground sees, for diffuse light),
// and, on a coarser grid of 64 x 64 cells per tile:
//   - the horizon angle in 18 directions (every 20 degrees), out to 20 km, so
//     the browser can tell which slopes are in a ridge's shadow at any sun
//     position.
//
// Surface normals come from the fine elevation model (USGS 3DEP 1/3 arc-second,
// ~10 m); horizons are traced on the coarse one (3DEP 1 arc-second, ~30 m),
// which also covers the 20 km of terrain around the square that can cast
// shadows into it.
//
// This module is pure: elevation arrives as in-memory grids, so the same code
// builds the published tiles (scripts/solar.mjs) and the local sample dataset.
// The tile format is decoded by web/src/lib/solar-tile.ts.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const SCHEMA_VERSION = 1;
/** Bump when the maths or the encoding changes; it is part of the tile path. */
export const ALGORITHM_VERSION = 1;
export const TILE_SIZE = 256;
export const MIN_ZOOM = 11;
export const MAX_ZOOM = 14;
/** Horizons are traced from the centres of this zoom's pixels (~28 m at Boise). */
export const HORIZON_ZOOM = 12;
/** Horizon cells per tile side, at every zoom (4 tile pixels per cell). */
export const HORIZON_CELLS = 64;
/** Extra ring of cells around each tile's horizon grid, for seamless interpolation. */
export const HORIZON_BORDER = 1;
export const AZIMUTHS_DEG = Array.from({ length: 18 }, (_, i) => i * 20);
/** Horizon angles are stored as bytes in steps of this many degrees (0 to 76.5). */
export const HORIZON_STEP_DEG = 0.3;
export const DEFAULT_RADIUS_KM = 15;
export const DEFAULT_MAX_DISTANCE_KM = 20;
/**
 * Side of the blocks a domain is built in, in zoom-14 pixels (16 tiles, ~28 km):
 * a multiple of a zoom-11 tile, so no tile spans two blocks. Memory then stays
 * the same however large a launch's area is.
 */
export const BLOCK_PX = 16 * TILE_SIZE;
/** Metres of fine elevation read around a block (the normals' border and the relief's outer corners). */
export const FINE_MARGIN_M = 250;

const DEG = Math.PI / 180;
const WGS84_A = 6378137;
const MEAN_EARTH_RADIUS_M = 6371008.8;
/** Standard terrestrial refraction coefficient: light bends over the curve, lifting distant terrain slightly. */
const REFRACTION_K = 0.13;
const CELL_PX = TILE_SIZE / HORIZON_CELLS;
const HORIZON_SIDE = HORIZON_CELLS + 2 * HORIZON_BORDER;

// ── Web Mercator ────────────────────────────────────────────────────────────

export const worldSize = (z) => TILE_SIZE * 2 ** z;
export const lonToX = (lon, z) => ((lon + 180) / 360) * worldSize(z);
export function latToY(lat, z) {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
}
export const xToLon = (x, z) => (x / worldSize(z)) * 360 - 180;
export const yToLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / worldSize(z)))) / DEG;
/** Ground size of one pixel (m) at a latitude; Mercator pixels are square on the ground. */
export const metresPerPixel = (lat, z) => (2 * Math.PI * WGS84_A * Math.cos(lat * DEG)) / worldSize(z);

/** Metres per degree of latitude and longitude on the WGS84 ellipsoid. */
export function metresPerDegree(lat) {
  const p = lat * DEG;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

// ── Elevation grids ─────────────────────────────────────────────────────────

/**
 * A north-up geographic elevation grid. Pixel (col, row) covers
 * [west + col*dLon, west + (col+1)*dLon] x [north - (row+1)*dLat, north - row*dLat];
 * values are metres, NaN where there is no data.
 * @typedef {{ values: Float32Array, width: number, height: number, west: number, north: number, dLon: number, dLat: number }} Grid
 */

/** Builds a grid by evaluating `elevation(lat, lon)` at pixel centres (tests and sample data). */
export function gridFromFunction(elevation, { south, west, north, east, dLon, dLat }) {
  const width = Math.ceil((east - west) / dLon);
  const height = Math.ceil((north - south) / dLat);
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const lat = north - (row + 0.5) * dLat;
    for (let col = 0; col < width; col += 1) values[row * width + col] = elevation(lat, west + (col + 0.5) * dLon);
  }
  return { values, width, height, west, north, dLon, dLat };
}

/** Bilinear elevation at (lat, lon); NaN outside the grid or next to missing data. */
export function sampleGrid(grid, lat, lon) {
  return bilinearAt(grid.values, grid.width, grid.height, (lon - grid.west) / grid.dLon - 0.5, (grid.north - lat) / grid.dLat - 0.5);
}

/** Bilinear interpolation at fractional pixel-centre coordinates (x, y); NaN outside. */
function bilinearAt(values, width, height, x, y) {
  if (!(x >= -0.5 && y >= -0.5 && x <= width - 0.5 && y <= height - 0.5)) return Number.NaN;
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.min(Math.floor(cx), width - 2 < 0 ? 0 : width - 2);
  const y0 = Math.min(Math.floor(cy), height - 2 < 0 ? 0 : height - 2);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = values[y0 * width + x0];
  const b = values[y0 * width + x1];
  const c = values[y1 * width + x0];
  const d = values[y1 * width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// ── Domain ──────────────────────────────────────────────────────────────────

/** A domain from a zoom-14 pixel box [x0, x1) x [y0, y1), with its geographic bounds. */
function boxDomain(x0, y0, x1, y1) {
  return {
    x0, y0, x1, y1,
    bounds: { south: yToLat(y1, MAX_ZOOM), west: xToLon(x0, MAX_ZOOM), north: yToLat(y0, MAX_ZOOM), east: xToLon(x1, MAX_ZOOM) },
  };
}

/**
 * The square of zoom-14 tiles covering `radiusKm` around a point. Returns the
 * zoom-14 pixel box [x0, x1) x [y0, y1) and its geographic bounds.
 */
export function domainFor(latitude, longitude, radiusKm) {
  const cx = lonToX(longitude, MAX_ZOOM);
  const cy = latToY(latitude, MAX_ZOOM);
  const r = (radiusKm * 1000) / metresPerPixel(latitude, MAX_ZOOM);
  const x0 = Math.floor((cx - r) / TILE_SIZE) * TILE_SIZE;
  const y0 = Math.floor((cy - r) / TILE_SIZE) * TILE_SIZE;
  const x1 = (Math.floor((cx + r) / TILE_SIZE) + 1) * TILE_SIZE;
  const y1 = (Math.floor((cy + r) / TILE_SIZE) + 1) * TILE_SIZE;
  return boxDomain(x0, y0, x1, y1);
}

/** The zoom-14 tiles covering a geographic box (a launch's own area, see sunlight-areas.json). */
export function domainForBounds({ south, west, north, east }) {
  const x0 = Math.floor(lonToX(west, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  const y0 = Math.floor(latToY(north, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  const x1 = Math.ceil(lonToX(east, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  const y1 = Math.ceil(latToY(south, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  return boxDomain(x0, y0, x1, y1);
}

/** A launch's sunlight-map domain: its own area when it has one, else the square of `radiusKm` around it. */
export function domainOf(site, { radiusKm = DEFAULT_RADIUS_KM, area } = {}) {
  return area ? domainForBounds(area) : domainFor(site.latitude, site.longitude, radiusKm);
}

/**
 * Splits a domain into blocks of at most BLOCK_PX x BLOCK_PX zoom-14 pixels,
 * on a grid aligned to zoom-11 tiles, so every tile of every zoom lies in
 * exactly one block and a large area is built one block at a time.
 */
export function blocksOf(domain) {
  const blocks = [];
  for (let by = Math.floor(domain.y0 / BLOCK_PX) * BLOCK_PX; by < domain.y1; by += BLOCK_PX) {
    for (let bx = Math.floor(domain.x0 / BLOCK_PX) * BLOCK_PX; bx < domain.x1; bx += BLOCK_PX) {
      blocks.push(boxDomain(Math.max(bx, domain.x0), Math.max(by, domain.y0), Math.min(bx + BLOCK_PX, domain.x1), Math.min(by + BLOCK_PX, domain.y1)));
    }
  }
  return blocks;
}

/** Geographic box around `bounds` extended by `metres` on every side. */
export function expandBounds(bounds, metres) {
  const mid = (bounds.south + bounds.north) / 2;
  const m = metresPerDegree(Math.abs(mid) + Math.abs(bounds.north - bounds.south) / 2);
  return {
    south: bounds.south - metres / m.lat,
    north: bounds.north + metres / m.lat,
    west: bounds.west - metres / m.lon,
    east: bounds.east + metres / m.lon,
  };
}

// ── Surface normals ─────────────────────────────────────────────────────────

/**
 * Samples the fine elevation model at zoom-14 pixel centres and derives the
 * surface normal of every pixel (Horn's 3x3 gradient). Returns the zoom-14
 * level with unit normals (east, north, up) and the mean elevation.
 */
export function surfaceLevel(fine, domain) {
  const z = MAX_ZOOM;
  const width = domain.x1 - domain.x0;
  const height = domain.y1 - domain.y0;
  const W = width + 2;
  const H = height + 2;
  const elevation = new Float32Array(W * H);
  const lons = new Float64Array(W);
  for (let i = 0; i < W; i += 1) lons[i] = xToLon(domain.x0 + i - 1 + 0.5, z);
  let sum = 0;
  let count = 0;
  for (let j = 0; j < H; j += 1) {
    const lat = yToLat(domain.y0 + j - 1 + 0.5, z);
    const row = j * W;
    for (let i = 0; i < W; i += 1) {
      const v = sampleGrid(fine, lat, lons[i]);
      elevation[row + i] = v;
      if (i > 0 && j > 0 && i < W - 1 && j < H - 1 && !Number.isNaN(v)) {
        sum += v;
        count += 1;
      }
    }
  }

  const n = width * height;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  for (let j = 0; j < height; j += 1) {
    const size = metresPerPixel(yToLat(domain.y0 + j + 0.5, z), z);
    const k = 1 / (8 * size);
    for (let i = 0; i < width; i += 1) {
      const c = (j + 1) * W + (i + 1);
      const a = elevation[c - W - 1], b = elevation[c - W], cc = elevation[c - W + 1];
      const d = elevation[c - 1], f = elevation[c + 1];
      const g = elevation[c + W - 1], h = elevation[c + W], ii = elevation[c + W + 1];
      const east = (cc + 2 * f + ii - (a + 2 * d + g)) * k;
      // Rows run south, so the northward gradient is minus the row gradient.
      const north = -(g + 2 * h + ii - (a + 2 * b + cc)) * k;
      const o = j * width + i;
      if (Number.isNaN(east) || Number.isNaN(north)) {
        nx[o] = ny[o] = nz[o] = Number.NaN;
        continue;
      }
      const len = Math.hypot(east, north, 1);
      nx[o] = -east / len;
      ny[o] = -north / len;
      nz[o] = 1 / len;
    }
  }
  return {
    level: { z, x0: domain.x0, y0: domain.y0, width, height, nx, ny, nz, svf: new Float32Array(n) },
    meanElevationM: count > 0 ? sum / count : Number.NaN,
    elevationSum: sum,
    elevationCount: count,
  };
}

// ── Horizons ────────────────────────────────────────────────────────────────

/** Ray-march distances (m): every 25 m near the cell, then growing 2 % per step. */
export function rayDistances(maxDistanceM, firstStepM = 25) {
  const out = [];
  for (let d = firstStepM; d <= maxDistanceM; d += Math.max(firstStepM, 0.02 * d)) out.push(d);
  return out;
}

/**
 * Traces the horizon angle (degrees above horizontal, never below 0) in every
 * direction of AZIMUTHS_DEG from the centre of each zoom-12 pixel in the domain
 * plus a one-cell ring, over the coarse elevation model. Accounts for earth
 * curvature and standard refraction.
 *
 * With `block`, only the cells that block's tiles read: the block and the
 * horizon border of its zoom-11 tiles, never past the domain's own ring, so a
 * domain built block by block gets exactly the tiles it gets in one go.
 */
export function traceHorizons(coarse, domain, { maxDistanceM = DEFAULT_MAX_DISTANCE_KM * 1000, block = null, log = () => {} } = {}) {
  const shift = 2 ** (MAX_ZOOM - HORIZON_ZOOM);
  let x0 = domain.x0 / shift - 1;
  let y0 = domain.y0 / shift - 1;
  let x1 = domain.x1 / shift + 1;
  let y1 = domain.y1 / shift + 1;
  if (block) {
    const pad = HORIZON_BORDER * CELL_PX * 2 ** (HORIZON_ZOOM - MIN_ZOOM);
    x0 = Math.max(x0, block.x0 / shift - pad);
    y0 = Math.max(y0, block.y0 / shift - pad);
    x1 = Math.min(x1, block.x1 / shift + pad);
    y1 = Math.min(y1, block.y1 / shift + pad);
  }
  const width = x1 - x0;
  const height = y1 - y0;
  const midLat = (domain.bounds.south + domain.bounds.north) / 2;
  const m = metresPerDegree(midLat);
  const dist = rayDistances(maxDistanceM);
  const steps = dist.length;
  const drop = Float64Array.from(dist, (d) => (d * d * (1 - REFRACTION_K)) / (2 * MEAN_EARTH_RADIUS_M));
  const offsets = AZIMUTHS_DEG.map((az) => ({
    dc: Float64Array.from(dist, (d) => (d * Math.sin(az * DEG)) / (m.lon * coarse.dLon)),
    dr: Float64Array.from(dist, (d) => -(d * Math.cos(az * DEG)) / (m.lat * coarse.dLat)),
  }));
  const { values, width: GW, height: GH } = coarse;
  let zMax = -Infinity;
  for (const v of values) if (v > zMax) zMax = v;

  const horizons = AZIMUTHS_DEG.map(() => new Float32Array(width * height));
  const lons = Float64Array.from({ length: width }, (_, i) => xToLon(x0 + i + 0.5, HORIZON_ZOOM));
  const started = Date.now();
  for (let j = 0; j < height; j += 1) {
    const lat = yToLat(y0 + j + 0.5, HORIZON_ZOOM);
    const rp = (coarse.north - lat) / coarse.dLat - 0.5;
    for (let i = 0; i < width; i += 1) {
      const cp = (lons[i] - coarse.west) / coarse.dLon - 0.5;
      const zp = bilinearAt(values, GW, GH, cp, rp);
      const o = j * width + i;
      if (Number.isNaN(zp)) continue; // no ground here: leave an open horizon
      for (let d = 0; d < AZIMUTHS_DEG.length; d += 1) {
        const { dc, dr } = offsets[d];
        let best = 0;
        for (let k = 0; k < steps; k += 1) {
          if ((zMax - zp) / dist[k] <= best) break; // nothing further can rise above the horizon found
          const x = cp + dc[k];
          const y = rp + dr[k];
          if (x < 0 || y < 0 || x > GW - 1 || y > GH - 1) break;
          const xi = x | 0;
          const yi = y | 0;
          const fx = x - xi;
          const fy = y - yi;
          const p = yi * GW + xi;
          const x1 = xi + 1 < GW ? 1 : 0;
          const y1 = yi + 1 < GH ? GW : 0;
          const z = (values[p] * (1 - fx) + values[p + x1] * fx) * (1 - fy) + (values[p + y1] * (1 - fx) + values[p + y1 + x1] * fx) * fy;
          const t = (z - drop[k] - zp) / dist[k];
          if (t > best) best = t;
        }
        horizons[d][o] = Math.atan(best) / DEG;
      }
    }
    if (j % 200 === 199) log(`  horizons: ${j + 1}/${height} rows (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  return { x0, y0, width, height, horizons };
}

/** Horizon angles (degrees) in every direction at a zoom-14 pixel centre. */
function horizonsAtPixel(grid, X, Y, out) {
  const shift = 2 ** (MAX_ZOOM - HORIZON_ZOOM);
  const fx = (X + 0.5) / shift - 0.5 - grid.x0;
  const fy = (Y + 0.5) / shift - 0.5 - grid.y0;
  const x = Math.min(Math.max(fx, 0), grid.width - 1);
  const y = Math.min(Math.max(fy, 0), grid.height - 1);
  const xi = Math.min(Math.floor(x), grid.width - 2);
  const yi = Math.min(Math.floor(y), grid.height - 2);
  const ax = x - xi;
  const ay = y - yi;
  const p = yi * grid.width + xi;
  for (let d = 0; d < out.length; d += 1) {
    const h = grid.horizons[d];
    out[d] = (h[p] * (1 - ax) + h[p + 1] * ax) * (1 - ay) + (h[p + grid.width] * (1 - ax) + h[p + grid.width + 1] * ax) * ay;
  }
  return out;
}

// ── Sky-view factor ─────────────────────────────────────────────────────────

const SIN_AZ = AZIMUTHS_DEG.map((a) => Math.sin(a * DEG));
const COS_AZ = AZIMUTHS_DEG.map((a) => Math.cos(a * DEG));

/**
 * Fraction of an isotropic sky seen by a surface with unit normal (nx, ny, nz)
 * under the given horizon angles (degrees, one per AZIMUTHS_DEG entry):
 * Dozier & Frew (1990), with the surface's own plane as a minimum horizon.
 * 1 for open flat ground, (1 + cos slope) / 2 for an open plane.
 */
export function skyViewFactor(nx, ny, nz, horizonsDeg) {
  let sum = 0;
  for (let d = 0; d < horizonsDeg.length; d += 1) {
    const tilt = nx * SIN_AZ[d] + ny * COS_AZ[d]; // tan(slope) * cos(azimuth - aspect) * nz
    const plane = nz > 1e-6 ? Math.atan(-tilt / nz) : tilt > 0 ? -Math.PI / 2 : Math.PI / 2;
    const h = Math.max(horizonsDeg[d] * DEG, plane);
    const H = Math.PI / 2 - h;
    const s = Math.sin(H);
    sum += nz * s * s + tilt * (H - s * Math.cos(H));
  }
  return Math.min(Math.max(sum / horizonsDeg.length, 0), 1);
}

function fillSkyView(level, horizonGrid) {
  const out = new Float32Array(AZIMUTHS_DEG.length);
  for (let j = 0; j < level.height; j += 1) {
    for (let i = 0; i < level.width; i += 1) {
      const o = j * level.width + i;
      if (Number.isNaN(level.nz[o])) {
        level.svf[o] = Number.NaN;
        continue;
      }
      horizonsAtPixel(horizonGrid, level.x0 + i, level.y0 + j, out);
      level.svf[o] = skyViewFactor(level.nx[o], level.ny[o], level.nz[o], out);
    }
  }
}

// ── Pyramid ─────────────────────────────────────────────────────────────────

/**
 * Halves a level: each pixel is the mean of its (valid) children. Normals are
 * averaged without renormalising, so a coarse pixel's direct-beam irradiance is
 * exactly the mean of its children's (the dot product is linear).
 */
export function halveLevel(level) {
  const x0 = Math.floor(level.x0 / 2);
  const y0 = Math.floor(level.y0 / 2);
  const width = Math.ceil((level.x0 + level.width) / 2) - x0;
  const height = Math.ceil((level.y0 + level.height) / 2) - y0;
  const n = width * height;
  const out = { z: level.z - 1, x0, y0, width, height, nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n), svf: new Float32Array(n) };
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      let sx = 0, sy = 0, sz = 0, sv = 0, count = 0;
      for (let dj = 0; dj < 2; dj += 1) {
        const cj = (y0 + j) * 2 + dj - level.y0;
        if (cj < 0 || cj >= level.height) continue;
        for (let di = 0; di < 2; di += 1) {
          const ci = (x0 + i) * 2 + di - level.x0;
          if (ci < 0 || ci >= level.width) continue;
          const c = cj * level.width + ci;
          if (Number.isNaN(level.nz[c])) continue;
          sx += level.nx[c]; sy += level.ny[c]; sz += level.nz[c]; sv += level.svf[c];
          count += 1;
        }
      }
      const o = j * width + i;
      if (count === 0) {
        out.nx[o] = out.ny[o] = out.nz[o] = out.svf[o] = Number.NaN;
      } else {
        out.nx[o] = sx / count; out.ny[o] = sy / count; out.nz[o] = sz / count; out.svf[o] = sv / count;
      }
    }
  }
  return out;
}

// ── Tiles ───────────────────────────────────────────────────────────────────

/** Byte layout of one tile before compression; see web/src/lib/solar-tile.ts. */
export const TILE_BYTES = 4 * TILE_SIZE * TILE_SIZE + AZIMUTHS_DEG.length * HORIZON_SIDE * HORIZON_SIDE;

const byteOfSigned = (v) => Math.min(255, Math.max(0, Math.round((v + 1) * 127.5)));
const byteOfUnit = (v) => Math.min(255, Math.max(1, Math.round(v * 255)));
const byteOfHorizon = (deg) => Math.min(255, Math.max(0, Math.round(deg / HORIZON_STEP_DEG)));

/**
 * Row-delta filter (like PNG's "Sub"): each byte becomes its difference from
 * the byte to its left, or from the byte above at the start of a row. Smooth
 * fields turn into runs of small numbers, which gzip compresses far better.
 */
export function deltaEncode(plane, width) {
  const out = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) {
    const prev = i % width === 0 ? (i === 0 ? 0 : plane[i - width]) : plane[i - 1];
    out[i] = (plane[i] - prev) & 255;
  }
  return out;
}

export function deltaDecode(encoded, width) {
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) {
    const prev = i % width === 0 ? (i === 0 ? 0 : out[i - width]) : out[i - 1];
    out[i] = (encoded[i] + prev) & 255;
  }
  return out;
}

/** Mean zoom-12 horizon over a block of cells, clamped to the traced area. */
function blockHorizon(grid, d, s0x, s0y, size) {
  const h = grid.horizons[d];
  let sum = 0;
  let count = 0;
  for (let y = s0y; y < s0y + size; y += 1) {
    const yy = Math.min(Math.max(y - grid.y0, 0), grid.height - 1);
    for (let x = s0x; x < s0x + size; x += 1) {
      const xx = Math.min(Math.max(x - grid.x0, 0), grid.width - 1);
      sum += h[yy * grid.width + xx];
      count += 1;
    }
  }
  return sum / count;
}

/** The uncompressed bytes of tile (tx, ty) of a level. */
export function encodeTile(level, horizonGrid, tx, ty) {
  const px = TILE_SIZE * TILE_SIZE;
  const bytes = new Uint8Array(TILE_BYTES);
  const nx = new Uint8Array(px), ny = new Uint8Array(px), nz = new Uint8Array(px), svf = new Uint8Array(px);
  let valid = 0;
  for (let j = 0; j < TILE_SIZE; j += 1) {
    const lj = ty * TILE_SIZE + j - level.y0;
    for (let i = 0; i < TILE_SIZE; i += 1) {
      const li = tx * TILE_SIZE + i - level.x0;
      const o = j * TILE_SIZE + i;
      const c = lj * level.width + li;
      if (li < 0 || lj < 0 || li >= level.width || lj >= level.height || Number.isNaN(level.nz[c])) {
        nx[o] = 128; ny[o] = 128; nz[o] = 0; svf[o] = 0; // nz = 0: no data
        continue;
      }
      nx[o] = byteOfSigned(level.nx[c]);
      ny[o] = byteOfSigned(level.ny[c]);
      nz[o] = byteOfUnit(level.nz[c]);
      svf[o] = byteOfUnit(level.svf[c]);
      valid += 1;
    }
  }
  [nx, ny, nz, svf].forEach((plane, p) => bytes.set(deltaEncode(plane, TILE_SIZE), p * px));

  // Horizon cells are CELL_PX tile pixels wide; in zoom-12 cells that is:
  const scale = 2 ** (HORIZON_ZOOM - level.z) * CELL_PX;
  let offset = 4 * px;
  const plane = new Uint8Array(HORIZON_SIDE * HORIZON_SIDE);
  for (let d = 0; d < AZIMUTHS_DEG.length; d += 1) {
    for (let cj = 0; cj < HORIZON_SIDE; cj += 1) {
      const sy = (ty * TILE_SIZE + (cj - HORIZON_BORDER) * CELL_PX) * 2 ** (HORIZON_ZOOM - level.z);
      for (let ci = 0; ci < HORIZON_SIDE; ci += 1) {
        const sx = (tx * TILE_SIZE + (ci - HORIZON_BORDER) * CELL_PX) * 2 ** (HORIZON_ZOOM - level.z);
        plane[cj * HORIZON_SIDE + ci] = byteOfHorizon(blockHorizon(horizonGrid, d, Math.floor(sx), Math.floor(sy), Math.max(1, scale)));
      }
    }
    bytes.set(deltaEncode(plane, HORIZON_SIDE), offset);
    offset += plane.length;
  }
  return { bytes, valid };
}

/** Tile index ranges [x0, y0, x1, y1] (inclusive) covering a level. */
export function tileRange(level) {
  return [
    Math.floor(level.x0 / TILE_SIZE),
    Math.floor(level.y0 / TILE_SIZE),
    Math.floor((level.x0 + level.width - 1) / TILE_SIZE),
    Math.floor((level.y0 + level.height - 1) / TILE_SIZE),
  ];
}

// ── Relief (the 3D view's ground) ───────────────────────────────────────────

/** Version of the relief file; it is part of the file name, so a format change never meets a cached copy. */
export const RELIEF_VERSION = 1;
/** Relief heights sit on the corners of this zoom's pixels (about 55 m apart at 44° N). */
export const RELIEF_ZOOM = 11;
/** Longest relief side, in heights; a larger area drops to a coarser zoom so the 3D view stays light. */
export const RELIEF_MAX_SIDE = 1200;
const RELIEF_OFFSET_M = 500;
const RELIEF_SCALE = 10;

/** The finest zoom (RELIEF_ZOOM at most) whose relief of the domain fits RELIEF_MAX_SIDE. */
export function reliefZoomFor(domain) {
  let z = RELIEF_ZOOM;
  while (z > 0 && Math.max(domain.x1 - domain.x0, domain.y1 - domain.y0) / 2 ** (MAX_ZOOM - z) + 2 > RELIEF_MAX_SIDE) z -= 1;
  return z;
}

/** An empty relief grid over the domain, filled block by block with fillRelief. */
export function reliefFrame(domain) {
  const zoom = reliefZoomFor(domain);
  const f = 2 ** (MAX_ZOOM - zoom);
  const x0 = Math.floor(domain.x0 / f);
  const y0 = Math.floor(domain.y0 / f);
  const width = Math.ceil(domain.x1 / f) - x0 + 1;
  const height = Math.ceil(domain.y1 / f) - y0 + 1;
  return { domain, zoom, f, x0, y0, width, height, values: new Uint16Array(width * height), min: Infinity, max: -Infinity };
}

/**
 * Fills the relief heights that fall in `block` (all of them without one) from
 * a fine elevation grid covering it. Heights on a block edge are filled by
 * both blocks, with the same value.
 */
export function fillRelief(frame, fine, block = frame.domain) {
  const { domain, zoom, f, x0, y0, width, height, values } = frame;
  const within = (p, lo, hi, blo, bhi) => {
    const c = Math.min(Math.max(p, lo), hi);
    return c >= blo && c <= bhi;
  };
  for (let j = 0; j < height; j += 1) {
    if (!within((y0 + j) * f, domain.y0, domain.y1, block.y0, block.y1)) continue;
    const lat = yToLat(y0 + j, zoom);
    for (let i = 0; i < width; i += 1) {
      if (!within((x0 + i) * f, domain.x0, domain.x1, block.x0, block.x1)) continue;
      const v = sampleGrid(fine, lat, xToLon(x0 + i, zoom));
      if (Number.isNaN(v)) continue;
      values[j * width + i] = Math.min(65535, Math.max(1, Math.round((v + RELIEF_OFFSET_M) * RELIEF_SCALE)));
      frame.min = Math.min(frame.min, v);
      frame.max = Math.max(frame.max, v);
    }
  }
}

/** The relief file and its index entry. */
export function encodeRelief(frame, generation) {
  const { zoom, x0, y0, width, height, values } = frame;
  const bytes = Buffer.alloc(values.length * 2);
  for (let k = 0; k < values.length; k += 1) {
    const prev = k % width === 0 ? (k === 0 ? 0 : values[k - width]) : values[k - 1];
    bytes.writeUInt16LE((values[k] - prev) & 0xffff, k * 2);
  }
  const body = gzipSync(bytes, { level: 9 });
  return {
    body,
    meta: {
      version: RELIEF_VERSION,
      path: `${generation}/relief-v${RELIEF_VERSION}.bin.gz`,
      zoom,
      x0,
      y0,
      width,
      height,
      offsetM: RELIEF_OFFSET_M,
      scale: RELIEF_SCALE,
      minM: round(frame.min, 0),
      maxM: round(frame.max, 0),
      encoding: "uint16 little-endian, (elevation m + offsetM) * scale, 0 = no data; row-delta (mod 65536); gzip",
      bytes: body.length,
    },
  };
}

/**
 * Elevation on a regular Web Mercator grid over the domain, for drawing the
 * terrain in 3D: one height per corner of the zoom-11 pixels (coarser for a
 * large area, see reliefZoomFor), so the grid's edges are the domain's edges
 * and the sunlight tiles drape onto it exactly.
 *
 * Stored as unsigned 16-bit little-endian values, (elevation + 500 m) in
 * decimetres (0 = no data), row by row from the north-west corner, each
 * row-delta filtered like the tiles (differences taken modulo 65536), gzipped.
 */
export function buildRelief(fine, domain, generation) {
  const frame = reliefFrame(domain);
  fillRelief(frame, fine);
  return encodeRelief(frame, generation);
}

/** Decodes a relief file's (gunzipped) bytes into heights in metres, NaN where there is no data. */
export function decodeRelief(raw, meta) {
  const n = meta.width * meta.height;
  const values = new Uint16Array(n);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k += 1) {
    const prev = k % meta.width === 0 ? (k === 0 ? 0 : values[k - meta.width]) : values[k - 1];
    values[k] = (raw[2 * k] | (raw[2 * k + 1] << 8)) + prev;
    out[k] = values[k] === 0 ? Number.NaN : values[k] / meta.scale - meta.offsetM;
  }
  return out;
}

/** True when a published index carries the current relief. */
export function reliefIsFresh(index) {
  return index?.relief?.version === RELIEF_VERSION;
}

// ── Whole product ───────────────────────────────────────────────────────────

/** Short content id for a set of inputs; part of the tile path so tiles can be cached forever. */
export function generationOf(inputs) {
  return createHash("sha256").update(JSON.stringify({ ...inputs, schemaVersion: SCHEMA_VERSION })).digest("hex").slice(0, 12);
}

const round = (v, digits) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

/**
 * Starts building one launch's tiles, block by block, so a large area never
 * has to be in memory at once:
 *
 *   const build = startSolarTerrain(site, { coarse, sources, radiusKm or area, maxDistanceKm });
 *   for (const block of build.blocks) tiles = build.addBlock(block, fineGridCoveringTheBlock);
 *   const { index, relief } = build.finish();
 *
 * `area` ({ name, south, west, north, east }) replaces the square of `radiusKm`
 * around the launch; the launch must be inside it.
 */
export function startSolarTerrain(site, { coarse, sources, radiusKm = DEFAULT_RADIUS_KM, area, maxDistanceKm = DEFAULT_MAX_DISTANCE_KM, log = () => {} }) {
  const inputs = {
    latitude: site.latitude,
    longitude: site.longitude,
    ...(area ? { area } : { radiusKm }),
    maxDistanceKm,
    algorithmVersion: ALGORITHM_VERSION,
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.id])),
  };
  const generation = generationOf(inputs);
  const domain = domainOf(site, { radiusKm, area });
  const LX = Math.floor(lonToX(site.longitude, MAX_ZOOM));
  const LY = Math.floor(latToY(site.latitude, MAX_ZOOM));
  if (LX < domain.x0 || LX >= domain.x1 || LY < domain.y0 || LY >= domain.y1) throw new Error(`${site.slug}: the launch is outside its sunlight area`);
  const blocks = blocksOf(domain);
  log(`${site.slug}: ${(domain.x1 - domain.x0) / TILE_SIZE} x ${(domain.y1 - domain.y0) / TILE_SIZE} tiles at zoom ${MAX_ZOOM}${blocks.length > 1 ? `, in ${blocks.length} blocks` : ""}`);

  const frame = reliefFrame(domain);
  const ranges = {};
  let count = 0, bytes = 0, rawBytes = 0, elevationSum = 0, elevationCount = 0, done = 0;
  let launch = null;

  function addBlock(block, fine) {
    const label = blocks.length > 1 ? `${site.slug} block ${done + 1}/${blocks.length}` : site.slug;
    let t = Date.now();
    const { level: top, elevationSum: sum, elevationCount: n } = surfaceLevel(fine, block);
    elevationSum += sum;
    elevationCount += n;
    log(`${label}: surface normals in ${Date.now() - t} ms`);
    t = Date.now();
    const horizonGrid = traceHorizons(coarse, domain, { maxDistanceM: maxDistanceKm * 1000, block, log });
    log(`${label}: horizons for ${horizonGrid.width * horizonGrid.height} cells in ${Math.round((Date.now() - t) / 1000)} s`);
    t = Date.now();
    fillSkyView(top, horizonGrid);
    log(`${label}: sky-view factor in ${Math.round((Date.now() - t) / 1000)} s`);

    const levels = [top];
    while (levels[0].z > MIN_ZOOM) levels.unshift(halveLevel(levels[0]));
    const tiles = [];
    for (const level of levels) {
      const [x0, y0, x1, y1] = tileRange(level);
      const r = ranges[level.z];
      ranges[level.z] = r ? [Math.min(r[0], x0), Math.min(r[1], y0), Math.max(r[2], x1), Math.max(r[3], y1)] : [x0, y0, x1, y1];
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const { bytes: raw, valid } = encodeTile(level, horizonGrid, x, y);
          if (valid === 0) continue;
          rawBytes += raw.length;
          tiles.push({ z: level.z, x, y, body: gzipSync(raw, { level: 9 }) });
        }
      }
    }
    count += tiles.length;
    bytes += tiles.reduce((s, tile) => s + tile.body.length, 0);
    fillRelief(frame, fine, block);

    // The launch itself, for checks and for the page.
    if (LX >= block.x0 && LX < block.x1 && LY >= block.y0 && LY < block.y1) {
      const o = (LY - top.y0) * top.width + (LX - top.x0);
      const horizons = horizonsAtPixel(horizonGrid, LX, LY, new Float32Array(AZIMUTHS_DEG.length));
      launch = {
        elevationM: round(sampleGrid(fine, site.latitude, site.longitude), 1),
        slopeDeg: round(Math.acos(Math.min(1, top.nz[o])) / DEG, 1),
        aspectDeg: round((Math.atan2(top.nx[o], top.ny[o]) / DEG + 360) % 360, 0),
        skyViewFactor: round(top.svf[o], 3),
        horizonDeg: Array.from(horizons, (h) => round(h, 1)),
      };
    }
    done += 1;
    return tiles;
  }

  function finish({ generatedAt } = {}) {
    if (done !== blocks.length) throw new Error(`${site.slug}: ${blocks.length - done} block(s) not built`);
    log(`${site.slug}: ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB compressed (${(rawBytes / 1e6).toFixed(0)} MB raw)`);
    const relief = encodeRelief(frame, generation);
    log(`${site.slug}: relief ${relief.meta.width} x ${relief.meta.height} at zoom ${relief.meta.zoom}, ${relief.meta.minM}–${relief.meta.maxM} m, ${(relief.body.length / 1e3).toFixed(0)} kB`);
    const index = {
      schemaVersion: SCHEMA_VERSION,
      slug: site.slug,
      generatedAt: generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      generation,
      inputs,
      sources,
      bounds: Object.fromEntries(Object.entries(domain.bounds).map(([k, v]) => [k, round(v, 6)])),
      referenceElevationM: round(elevationCount > 0 ? elevationSum / elevationCount : Number.NaN, 0),
      tiles: {
        path: `${generation}/{z}/{x}/{y}.bin.gz`,
        size: TILE_SIZE,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        ranges,
        count,
        bytes,
      },
      encoding: {
        planes: ["nx", "ny", "nz", "svf"],
        normal: "nx, ny: byte / 127.5 - 1 (east, north components); nz, svf: byte / 255; nz = 0 marks no data",
        horizonCells: HORIZON_CELLS,
        horizonBorder: HORIZON_BORDER,
        azimuthsDeg: AZIMUTHS_DEG,
        horizonStepDeg: HORIZON_STEP_DEG,
        delta: "row",
        compression: "gzip",
      },
      launch,
      relief: relief.meta,
    };
    return { index, relief };
  }

  return { domain, blocks, generation, addBlock, finish };
}

/**
 * Builds every tile and the index for one launch from elevation grids that
 * cover its whole domain (fine) and 20 km around it (coarse).
 * @param {{ slug: string, latitude: number, longitude: number }} site
 * @param {{ fine: Grid, coarse: Grid, sources: object, radiusKm?: number, area?: object, maxDistanceKm?: number, generatedAt?: string, log?: (m: string) => void }} options
 * @returns {{ index: object, tiles: { z: number, x: number, y: number, body: Buffer }[], relief: { meta: object, body: Buffer } }}
 */
export function buildSolarTerrain(site, { fine, generatedAt, ...options }) {
  const build = startSolarTerrain(site, options);
  const tiles = [];
  for (const block of build.blocks) for (const tile of build.addBlock(block, fine)) tiles.push(tile);
  return { ...build.finish({ generatedAt }), tiles };
}

/** True when a published index was built from exactly these inputs. */
export function indexIsFresh(index, site, { sources, radiusKm = DEFAULT_RADIUS_KM, area, maxDistanceKm = DEFAULT_MAX_DISTANCE_KM }) {
  if (!index || index.schemaVersion !== SCHEMA_VERSION) return false;
  const i = index.inputs ?? {};
  return (
    i.latitude === site.latitude &&
    i.longitude === site.longitude &&
    (area ? JSON.stringify(i.area) === JSON.stringify(area) : i.area === undefined && i.radiusKm === radiusKm) &&
    i.maxDistanceKm === maxDistanceKm &&
    i.algorithmVersion === ALGORITHM_VERSION &&
    (!sources || Object.entries(sources).every(([k, v]) => i.sources?.[k] === v.id))
  );
}
