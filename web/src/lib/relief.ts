// The ground the sunlight map's 3D view is drawn on: elevation on a regular
// Web Mercator grid over the launch's square, built by
// forecasts/scripts/lib/solar.mjs (buildRelief), which documents the format.

export interface ReliefMeta {
  version: number;
  /** Path under /data/solar/<slug>/. */
  path: string;
  /** Heights sit on the corners of this zoom's pixels. */
  zoom: number;
  /** Pixel coordinates of the north-west corner at `zoom`. */
  x0: number;
  y0: number;
  /** Number of heights per row and per column. */
  width: number;
  height: number;
  offsetM: number;
  scale: number;
  minM: number | null;
  maxM: number | null;
  bytes: number;
}

/** Decodes the gunzipped bytes into metres, NaN where there is no data. */
export function decodeRelief(raw: Uint8Array, meta: ReliefMeta): Float32Array {
  const n = meta.width * meta.height;
  if (raw.length !== 2 * n) throw new Error(`relief has ${raw.length} bytes, expected ${2 * n}`);
  const values = new Uint16Array(n);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k += 1) {
    const prev = k % meta.width === 0 ? (k === 0 ? 0 : values[k - meta.width]) : values[k - 1];
    values[k] = (raw[2 * k] | (raw[2 * k + 1] << 8)) + prev;
    out[k] = values[k] === 0 ? Number.NaN : values[k] / meta.scale - meta.offsetM;
  }
  return out;
}

export async function fetchRelief(url: string, meta: ReliefMeta): Promise<Float32Array | null> {
  const response = await fetch(url);
  if (!response.ok || !response.body) return null;
  const raw = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  return decodeRelief(raw, meta);
}

const worldSize = (z: number) => 256 * 2 ** z;

/** Web Mercator pixel (at zoom z) to latitude and longitude. */
export function pixelToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const w = worldSize(z);
  return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / w))) * 180) / Math.PI, lon: (x / w) * 360 - 180 };
}

/** Latitude and longitude to Web Mercator pixel at zoom z. */
export function latLonToPixel(lat: number, lon: number, z: number): { x: number; y: number } {
  const w = worldSize(z);
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * w, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * w };
}

/** Ground metres per pixel at zoom z and latitude (WGS84 equatorial radius, as the tiles use). */
export const metresPerPixel = (lat: number, z: number) => (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / worldSize(z);

/** Height at a fractional grid position (bilinear; NaN corners fall back to the others). */
export function heightAt(heights: Float32Array, meta: ReliefMeta, gx: number, gy: number): number {
  const i = Math.min(Math.max(Math.floor(gx), 0), meta.width - 2);
  const j = Math.min(Math.max(Math.floor(gy), 0), meta.height - 2);
  const fx = Math.min(Math.max(gx - i, 0), 1);
  const fy = Math.min(Math.max(gy - j, 0), 1);
  const corners = [
    [heights[j * meta.width + i], (1 - fx) * (1 - fy)],
    [heights[j * meta.width + i + 1], fx * (1 - fy)],
    [heights[(j + 1) * meta.width + i], (1 - fx) * fy],
    [heights[(j + 1) * meta.width + i + 1], fx * fy],
  ];
  let sum = 0;
  let weight = 0;
  for (const [h, w] of corners) {
    if (Number.isNaN(h)) continue;
    sum += h * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : Number.NaN;
}
