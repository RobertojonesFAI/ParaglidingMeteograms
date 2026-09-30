// Reads the sunlight map's terrain tiles (built by forecasts/scripts/lib/solar.mjs)
// and turns one tile plus a sun position into W/m² per pixel.
//
// Tile bytes, after gunzip, each plane row-delta filtered:
//   nx, ny, nz, svf    TILE_SIZE² bytes each: surface normal and sky-view factor
//   horizons           one (cells + 2·border)² plane per azimuth, in HORIZON_STEP_DEG steps

import { ALBEDO, SHADOW_EDGE_DEG, azimuthWeights, litFraction, onSurface, type Sky } from "./irradiance.ts";

export interface SolarIndex {
  schemaVersion: 1;
  slug: string;
  generatedAt: string;
  generation: string;
  inputs: { latitude: number; longitude: number; radiusKm: number; maxDistanceKm: number };
  sources: Record<string, { id: string; name: string; resolutionM: number; licence: string; url: string }>;
  bounds: { south: number; west: number; north: number; east: number };
  referenceElevationM: number;
  tiles: { path: string; size: number; minZoom: number; maxZoom: number; ranges: Record<string, [number, number, number, number]>; count: number; bytes: number };
  encoding: { horizonCells: number; horizonBorder: number; azimuthsDeg: number[]; horizonStepDeg: number };
  launch: { elevationM: number | null; slopeDeg: number | null; aspectDeg: number | null; skyViewFactor: number | null; horizonDeg: (number | null)[] };
}

export interface SolarTile {
  size: number;
  /** Surface normal and sky-view factor as stored bytes (see NX/NZ decoding below); bz = 0 means no terrain. */
  bx: Uint8Array;
  by: Uint8Array;
  bz: Uint8Array;
  bs: Uint8Array;
  /** Horizon angle bytes per azimuth, side × side cells. */
  horizons: Uint8Array[];
  side: number;
  border: number;
  /** Tile pixels per horizon cell. */
  cellPx: number;
  stepDeg: number;
}

/** The sun and sky for one moment, shared by every tile drawn for it. */
export interface Frame {
  elevationDeg: number;
  azimuthDeg: number;
  sun: [number, number, number];
  sky: Sky;
}

export function deltaDecode(encoded: Uint8Array, width: number): Uint8Array {
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) {
    const prev = i % width === 0 ? (i === 0 ? 0 : out[i - width]) : out[i - 1];
    out[i] = (encoded[i] + prev) & 255;
  }
  return out;
}

export function tileBytes(index: SolarIndex): number {
  const side = index.encoding.horizonCells + 2 * index.encoding.horizonBorder;
  return 4 * index.tiles.size ** 2 + index.encoding.azimuthsDeg.length * side * side;
}

/** Decodes an uncompressed tile. */
export function decodeTile(raw: Uint8Array, index: SolarIndex): SolarTile {
  const size = index.tiles.size;
  const px = size * size;
  const { horizonCells, horizonBorder, azimuthsDeg, horizonStepDeg } = index.encoding;
  const side = horizonCells + 2 * horizonBorder;
  if (raw.length !== tileBytes(index)) throw new Error(`sunlight tile has ${raw.length} bytes, expected ${tileBytes(index)}`);
  const plane = (p: number) => deltaDecode(raw.subarray(p * px, (p + 1) * px), size);
  const [bx, by, bz, bs] = [0, 1, 2, 3].map(plane);
  const horizons: Uint8Array[] = [];
  let offset = 4 * px;
  for (let d = 0; d < azimuthsDeg.length; d += 1) {
    horizons.push(deltaDecode(raw.subarray(offset, offset + side * side), side));
    offset += side * side;
  }
  return { size, bx, by, bz, bs, horizons, side, border: horizonBorder, cellPx: size / horizonCells, stepDeg: horizonStepDeg };
}

/** Fetches and decodes one tile; null when it does not exist. */
export async function fetchTile(url: string, index: SolarIndex, signal?: AbortSignal): Promise<SolarTile | null> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) return null;
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  return decodeTile(raw, index);
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const SIGNED = 1 / 127.5;
const UNIT = 1 / 255;

/** Cell coordinate lookup for tile pixels: the cell to the upper-left and the weight toward the next. */
function cellAxis(size: number, cellPx: number, border: number, side: number) {
  const i0 = new Int32Array(size);
  const f = new Float32Array(size);
  for (let p = 0; p < size; p += 1) {
    const u = Math.min(Math.max((p + 0.5) / cellPx - 0.5 + border, 0), side - 1.000001);
    i0[p] = Math.floor(u);
    f[p] = u - i0[p];
  }
  return { i0, f };
}

const axes = new Map<string, ReturnType<typeof cellAxis>>();
function axisFor(tile: SolarTile) {
  const key = `${tile.size}/${tile.cellPx}/${tile.border}/${tile.side}`;
  let axis = axes.get(key);
  if (!axis) axes.set(key, (axis = cellAxis(tile.size, tile.cellPx, tile.border, tile.side)));
  return axis;
}

/** Horizon angle (degrees) toward the frame's sun azimuth, for every horizon cell. */
function horizonPlane(tile: SolarTile, azimuthDeg: number, out: Float32Array) {
  const { i0, i1, w } = azimuthWeights(azimuthDeg, tile.horizons.length);
  const a = tile.horizons[i0];
  const b = tile.horizons[i1];
  for (let k = 0; k < out.length; k += 1) out[k] = (a[k] * (1 - w) + b[k] * w) * tile.stepDeg;
  return out;
}

/**
 * Computes W/m² for every pixel of a tile and writes it as colour through a
 * 256-entry RGBA lookup table spanning 0 to `maxWm2`. Pixels without terrain
 * are transparent.
 */
export function renderTile(tile: SolarTile, frame: Frame, rgba: Uint8ClampedArray, lut: Uint8Array, maxWm2: number, scratch = new Float32Array(tile.side * tile.side)) {
  const { size, side, bx, by, bz, bs } = tile;
  const plane = horizonPlane(tile, frame.azimuthDeg, scratch);
  const { i0, f } = axisFor(tile);
  const scale = 255 / maxWm2;
  const el = frame.elevationDeg;
  const [sx, sy, sz] = frame.sun;
  const { dni, dhi, ghi } = frame.sky;
  const reflected = ALBEDO * ghi;
  for (let py = 0; py < size; py += 1) {
    const r0 = i0[py] * side;
    const fy = f[py];
    for (let px = 0; px < size; px += 1) {
      const o = py * size + px;
      const q = o * 4;
      if (bz[o] === 0) {
        rgba[q + 3] = 0;
        continue;
      }
      const c = r0 + i0[px];
      const fx = f[px];
      const h = (plane[c] * (1 - fx) + plane[c + 1] * fx) * (1 - fy) + (plane[c + side] * (1 - fx) + plane[c + side + 1] * fx) * fy;
      const t = (el - h) / SHADOW_EDGE_DEG + 0.5;
      const lit = t <= 0 ? 0 : t >= 1 ? 1 : t;
      const cos = (bx[o] * SIGNED - 1) * sx + (by[o] * SIGNED - 1) * sy + bz[o] * UNIT * sz;
      const svf = bs[o] * UNIT;
      const v = (cos > 0 ? dni * cos * lit : 0) + dhi * svf + reflected * (1 - svf);
      const k = Math.min(255, (v * scale) | 0) * 4;
      rgba[q] = lut[k];
      rgba[q + 1] = lut[k + 1];
      rgba[q + 2] = lut[k + 2];
      rgba[q + 3] = lut[k + 3];
    }
  }
}

/** Everything about one tile pixel's terrain, for computing its whole day. */
export interface PointTerrain {
  nx: number;
  ny: number;
  nz: number;
  svf: number;
  /** Horizon angle (degrees) per azimuth. */
  horizonsDeg: Float32Array;
}

export function pointTerrain(tile: SolarTile, px: number, py: number): PointTerrain | null {
  const o = py * tile.size + px;
  if (tile.bz[o] === 0) return null;
  const { i0, f } = axisFor(tile);
  const c = i0[py] * tile.side + i0[px];
  const fx = f[px];
  const fy = f[py];
  const horizonsDeg = Float32Array.from(tile.horizons, (h) =>
    ((h[c] * (1 - fx) + h[c + 1] * fx) * (1 - fy) + (h[c + tile.side] * (1 - fx) + h[c + tile.side + 1] * fx) * fy) * tile.stepDeg,
  );
  return { nx: tile.bx[o] * SIGNED - 1, ny: tile.by[o] * SIGNED - 1, nz: tile.bz[o] * UNIT, svf: tile.bs[o] * UNIT, horizonsDeg };
}

/** The parts of one point's sunlight for a frame, W/m². */
export function pointParts(point: PointTerrain, frame: Frame) {
  if (frame.sky.ghi <= 0) return { total: 0, direct: 0, ridgeShadow: false, facingAway: false };
  const { i0, i1, w } = azimuthWeights(frame.azimuthDeg, point.horizonsDeg.length);
  const h = point.horizonsDeg[i0] * (1 - w) + point.horizonsDeg[i1] * w;
  const lit = litFraction(frame.elevationDeg, h);
  const total = onSurface(frame.sky, frame.sun, point.nx, point.ny, point.nz, point.svf, lit);
  const cos = point.nx * frame.sun[0] + point.ny * frame.sun[1] + point.nz * frame.sun[2];
  const direct = cos > 0 ? frame.sky.dni * cos * lit : 0;
  return { total, direct, ridgeShadow: frame.elevationDeg > 0 && lit < 0.5, facingAway: frame.elevationDeg > 0 && cos <= 0 };
}

/** W/m² at one point for a frame. */
export function pointIrradiance(point: PointTerrain, frame: Frame): number {
  return pointParts(point, frame).total;
}

// ── Colour ──────────────────────────────────────────────────────────────────

/**
 * Sequential orange ramp, light (little sunlight) to dark (full sun): one hue,
 * lightness evenly stepped in OKLCH and checked monotone.
 */
export const RAMP = ["#fdf1e4", "#f8d7b5", "#f4bb8a", "#ef9d60", "#e57f3f", "#d66427", "#bf4e1c", "#a53d19", "#86311a"];

/** 256-entry RGBA table interpolating RAMP. */
export function rampLut(ramp = RAMP, alpha = 255): Uint8Array {
  const rgb = ramp.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  const lut = new Uint8Array(256 * 4);
  for (let k = 0; k < 256; k += 1) {
    const t = (k / 255) * (rgb.length - 1);
    const i = Math.min(Math.floor(t), rgb.length - 2);
    const w = t - i;
    for (let ch = 0; ch < 3; ch += 1) lut[k * 4 + ch] = Math.round(rgb[i][ch] * (1 - w) + rgb[i + 1][ch] * w);
    lut[k * 4 + 3] = alpha;
  }
  return lut;
}
