import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { buildRelief, decodeRelief as decodeInNode, domainFor, gridFromFunction } from "../../forecasts/scripts/lib/solar.mjs";
import { decodeRelief, heightAt, latLonToPixel, metresPerPixel, pixelToLatLon, type ReliefMeta } from "../src/lib/relief.ts";

const LAT = 43.62332;
const LON = -115.98076;

test("the page decodes the relief exactly as it was built", () => {
  const domain = domainFor(LAT, LON, 1);
  const b = domain.bounds;
  const elevation = (lat: number, lon: number) => 1200 + 4000 * (lat - LAT) - 3000 * (lon - LON);
  const fine = gridFromFunction(elevation, { south: b.south - 0.002, north: b.north + 0.002, west: b.west - 0.003, east: b.east + 0.003, dLon: 1 / 10800, dLat: 1 / 10800 });
  const { body, meta } = buildRelief(fine, domain, "abc");
  const raw = gunzipSync(body);
  const inPage = decodeRelief(raw, meta as ReliefMeta);
  assert.deepEqual(Array.from(inPage), Array.from(decodeInNode(raw, meta)));

  // The launch's height, interpolated from the grid, matches the plane.
  const p = latLonToPixel(LAT, LON, meta.zoom);
  const h = heightAt(inPage, meta as ReliefMeta, p.x - meta.x0, p.y - meta.y0);
  assert.ok(Math.abs(h - 1200) < 0.5, `launch height ${h}`);
  assert.throws(() => decodeRelief(raw.subarray(2), meta as ReliefMeta), /bytes/);
});

test("Web Mercator pixels and coordinates round-trip; pixel size matches the tiles'", () => {
  const p = latLonToPixel(LAT, LON, 11);
  const back = pixelToLatLon(p.x, p.y, 11);
  assert.ok(Math.abs(back.lat - LAT) < 1e-9 && Math.abs(back.lon - LON) < 1e-9);
  assert.ok(Math.abs(metresPerPixel(LAT, 11) - 55.3) < 0.2, `${metresPerPixel(LAT, 11)}`);
});

test("height lookups skip corners without data", () => {
  const meta = { width: 2, height: 2 } as ReliefMeta;
  assert.equal(heightAt(Float32Array.from([100, Number.NaN, 300, Number.NaN]), meta, 0.5, 0.5), 200);
  assert.ok(Number.isNaN(heightAt(Float32Array.from([Number.NaN, Number.NaN, Number.NaN, Number.NaN]), meta, 0.5, 0.5)));
});
