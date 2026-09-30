// Joins neighbouring raster tiles into one virtual dataset.
//
// The meteo engine measures a launch's terrain and land cover from a window
// around it, read from ONE tile (Copernicus GLO-30 is cut into 1° tiles, ESA
// WorldCover into 3° tiles). A launch within ~10 km of a tile edge makes that
// window cross into the next tile, and engine 0.6.0 stops with "stitching
// neighbouring tiles is not implemented". Around Boise the 116°W meridian runs
// right through the foothills, so most local launches hit this.
//
// A mosaic here has the same shape as the engine's opened tile
// ({ width, height, transform, nodata, epsg, readWindow }), so the engine's
// own window, relief and land-cover functions run on it unchanged.

/**
 * @typedef {{ width: number, height: number, transform: number[], nodata: number | null, epsg: number | null,
 *             readWindow(col0: number, row0: number, cols: number, rows: number): Promise<ArrayLike<number> & { constructor: any }> }} Dataset
 */

const close = (a, b) => Math.abs(a - b) <= Math.abs(a) * 1e-9;

/** Tile URLs covering the box lat ± dLat, lon ± dLon, for a url-of-point function. */
export function tilesAround(urlOf, latitude, longitude, dLat, dLon) {
  const urls = new Set();
  for (const lat of [latitude - dLat, latitude, latitude + dLat]) {
    for (const lon of [longitude - dLon, longitude, longitude + dLon]) urls.add(urlOf(lat, lon));
  }
  return [...urls];
}

/**
 * Builds a mosaic from opened tiles on the same north-up grid. Tiles may be
 * missing (e.g. open ocean has no GLO-30 tile); areas no tile covers read as
 * nodata, which the engine already treats as "no data here".
 * @param {Dataset[]} tiles
 * @returns {Dataset}
 */
export function mosaic(tiles) {
  if (tiles.length === 0) throw new Error("mosaic: no tiles");
  if (tiles.length === 1) return tiles[0];
  const [a, b, , d, e] = tiles[0].transform;
  if (b !== 0 || d !== 0 || !(a > 0) || !(e < 0)) throw new Error("mosaic: tiles must be north-up with no rotation");
  for (const tile of tiles) {
    const [ta, , , , te] = tile.transform;
    if (!close(ta, a) || !close(te, e)) throw new Error("mosaic: tiles have different resolutions");
    if (tile.epsg !== tiles[0].epsg) throw new Error("mosaic: tiles have different coordinate systems");
    if (tile.nodata !== tiles[0].nodata && !(Number.isNaN(tile.nodata) && Number.isNaN(tiles[0].nodata))) {
      throw new Error("mosaic: tiles have different nodata values");
    }
  }

  const originX = Math.min(...tiles.map((t) => t.transform[2]));
  const originY = Math.max(...tiles.map((t) => t.transform[5]));
  const placed = tiles.map((tile) => {
    const col = (tile.transform[2] - originX) / a;
    const row = (tile.transform[5] - originY) / e;
    // A thousandth of a pixel: USGS 3DEP tiles sit exactly 1° apart, but their
    // stored pixel size is rounded, which shows up as ~1e-5 px over 10 800 px.
    if (Math.abs(col - Math.round(col)) > 1e-3 || Math.abs(row - Math.round(row)) > 1e-3) {
      throw new Error("mosaic: tiles are not aligned to a common pixel grid");
    }
    return { tile, col: Math.round(col), row: Math.round(row) };
  });
  const nodata = tiles[0].nodata;

  return {
    width: Math.max(...placed.map((p) => p.col + p.tile.width)),
    height: Math.max(...placed.map((p) => p.row + p.tile.height)),
    transform: [a, 0, originX, 0, e, originY],
    nodata,
    epsg: tiles[0].epsg,
    async readWindow(col0, row0, cols, rows) {
      let out = null;
      for (const { tile, col, row } of placed) {
        const c0 = Math.max(col0, col);
        const c1 = Math.min(col0 + cols, col + tile.width);
        const r0 = Math.max(row0, row);
        const r1 = Math.min(row0 + rows, row + tile.height);
        if (c0 >= c1 || r0 >= r1) continue;
        const width = c1 - c0;
        const part = await tile.readWindow(c0 - col, r0 - row, width, r1 - r0);
        if (out === null) {
          out = new part.constructor(cols * rows);
          if (nodata !== null) out.fill(nodata);
        }
        for (let r = 0; r < r1 - r0; r += 1) {
          out.set(part.subarray(r * width, (r + 1) * width), (r0 - row0 + r) * cols + (c0 - col0));
        }
      }
      if (out === null) throw new Error("mosaic: the requested window lies outside every tile");
      return out;
    },
  };
}
