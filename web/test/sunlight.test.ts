import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { sunPosition, sunriseSunset, sunVector } from "../src/lib/sun.ts";
import { airMass, azimuthWeights, clearSky, litFraction, onSurface, withClouds } from "../src/lib/irradiance.ts";
import { RAMP, decodeTile, pointIrradiance, pointTerrain, rampLut, renderTile, type Frame, type SolarIndex } from "../src/lib/solar-tile.ts";
// The tile encoder lives with the forecast operator; the round trip below keeps both sides in step.
import { buildSolarTerrain, domainFor, gridFromFunction, latToY, lonToX, metresPerDegree } from "../../forecasts/scripts/lib/solar.mjs";

const LAT = 43.62332;
const LON = -115.98076;

// Reference values from NREL's Solar Position Algorithm (pvlib 0.16.1, method "nrel_numpy").
const SPA = [
  { t: "2026-09-30T19:00:00Z", lat: LAT, lon: LON, azimuth: 168.473, elevation: 42.746, trueElevation: 42.731 },
  { t: "2026-06-21T13:00:00Z", lat: LAT, lon: LON, azimuth: 65.309, elevation: 8.295, trueElevation: 8.203 },
  { t: "2026-12-21T19:30:00Z", lat: LAT, lon: LON, azimuth: 176.977, elevation: 22.913, trueElevation: 22.879 },
  { t: "2026-03-20T01:30:00Z", lat: LAT, lon: LON, azimuth: 266.13, elevation: 3.902, trueElevation: 3.733 },
  { t: "2026-07-15T16:15:00Z", lat: 46.5, lon: 7.9, azimuth: 271.46, elevation: 28.893, trueElevation: 28.868 },
  { t: "2027-02-03T03:00:00Z", lat: -33.4, lon: -70.6, azimuth: 213.596, elevation: -32.828, trueElevation: -32.828 },
  { t: "2026-10-10T14:05:00Z", lat: 19.4, lon: -99.1, azimuth: 105.752, elevation: 21.289, trueElevation: 21.256 },
];

test("sun position matches NREL's Solar Position Algorithm", () => {
  for (const c of SPA) {
    const p = sunPosition(Date.parse(c.t), c.lat, c.lon);
    assert.ok(Math.abs(p.azimuthDeg - c.azimuth) < 0.03, `${c.t} azimuth ${p.azimuthDeg} vs ${c.azimuth}`);
    assert.ok(Math.abs(p.trueElevationDeg - c.trueElevation) < 0.02, `${c.t} elevation ${p.trueElevationDeg} vs ${c.trueElevation}`);
    // Refraction models differ slightly near the horizon (pvlib used local pressure and 12 °C).
    if (c.elevation > 0) assert.ok(Math.abs(p.elevationDeg - c.elevation) < 0.1, `${c.t} apparent ${p.elevationDeg} vs ${c.elevation}`);
  }
});

test("sunrise and sunset at Cervidae match NREL's to within 30 seconds", () => {
  // Local days in America/Boise. References: where NREL SPA positions (pvlib, 10 s steps)
  // cross the standard -0.833° sunrise/sunset elevation.
  const cases = [
    { start: "2026-09-30T06:00:00Z", rise: "2026-09-30T13:40:35Z", set: "2026-10-01T01:26:25Z" },
    { start: "2026-06-21T06:00:00Z", rise: "2026-06-21T12:02:35Z", set: "2026-06-22T03:29:05Z" },
    { start: "2026-12-21T07:00:00Z", rise: "2026-12-21T15:14:15Z", set: "2026-12-22T00:10:05Z" },
  ];
  for (const c of cases) {
    const start = Date.parse(c.start);
    const got = sunriseSunset(start, start + 86_400_000, LAT, LON);
    assert.ok(got);
    assert.ok(Math.abs(got.sunrise - Date.parse(c.rise)) < 30_000, `${c.start} sunrise ${new Date(got.sunrise).toISOString()}`);
    assert.ok(Math.abs(got.sunset - Date.parse(c.set)) < 30_000, `${c.start} sunset ${new Date(got.sunset).toISOString()}`);
  }
  const v = sunVector(sunPosition(Date.parse("2026-09-30T19:00:00Z"), LAT, LON));
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
  assert.ok(v[1] < 0 && v[2] > 0, "early afternoon sun is south and up");
});

test("clear sky is close to Ineichen's model at Cervidae, and dark at night", () => {
  // pvlib Ineichen clear sky (climatological turbidity) at 1268 m, 2026-09-30 13:00 MDT: GHI 732, DNI 962.
  const sun = sunPosition(Date.parse("2026-09-30T19:00:00Z"), LAT, LON);
  const sky = clearSky(sun, 1268);
  assert.ok(Math.abs(sky.ghi - 732) < 40, `ghi ${sky.ghi}`);
  assert.ok(Math.abs(sky.dni - 962) < 50, `dni ${sky.dni}`);
  assert.deepEqual(clearSky({ elevationDeg: -2, distanceFactor: 1 }, 1268), { dni: 0, dhi: 0, ghi: 0 });
  assert.ok(Math.abs(airMass(0) - 1) < 0.001);
  assert.ok(airMass(80) > 5.5 && airMass(80) < 5.7);
});

test("clouds dim the sky and turn the light diffuse", () => {
  const clear = { dni: 900, dhi: 90, ghi: 90 + 900 * Math.sin(45 * Math.PI / 180) };
  const none = withClouds(clear, 45, 0);
  assert.ok(Math.abs(none.dni - clear.dni) < 1e-9 && Math.abs(none.ghi - clear.ghi) < 1e-9);
  const overcast = withClouds(clear, 45, 1);
  assert.ok(Math.abs(overcast.ghi - 0.25 * clear.ghi) < 1e-9);
  assert.ok(Math.abs(overcast.dni) < 1e-9);
  const half = withClouds(clear, 45, 0.5);
  assert.ok(half.ghi < clear.ghi && half.ghi > 0.9 * clear.ghi, "Kasten & Czeplak: 50 % cloud barely dims the total");
  assert.ok(half.dhi / half.ghi > clear.dhi / clear.ghi);
});

test("flat open ground receives exactly the sky's total; a hidden sun leaves only diffuse light", () => {
  const sun = sunPosition(Date.parse("2026-09-30T19:00:00Z"), LAT, LON);
  const sky = clearSky(sun, 1268);
  const s = sunVector(sun);
  assert.ok(Math.abs(onSurface(sky, s, 0, 0, 1, 1, 1) - sky.ghi) < 1e-9);
  assert.ok(Math.abs(onSurface(sky, s, 0, 0, 1, 1, 0) - sky.dhi) < 1e-9);
  // A slope facing the sun gets more than flat ground; one facing away, less.
  const facing = onSurface(sky, s, 0.4 * s[0] / Math.hypot(s[0], s[1]), 0.4 * s[1] / Math.hypot(s[0], s[1]), Math.sqrt(1 - 0.16), 0.96, 1);
  const away = onSurface(sky, s, -0.4 * s[0] / Math.hypot(s[0], s[1]), -0.4 * s[1] / Math.hypot(s[0], s[1]), Math.sqrt(1 - 0.16), 0.96, 1);
  assert.ok(facing > sky.ghi && away < sky.ghi);
  assert.equal(litFraction(10, 12), 0);
  assert.equal(litFraction(12, 10), 1);
  assert.equal(litFraction(10, 10), 0.5);
  assert.deepEqual(azimuthWeights(350, 18), { i0: 17, i1: 0, w: 0.5 });
  assert.deepEqual(azimuthWeights(0, 18), { i0: 0, i1: 1, w: 0 });
});

test("the colour table runs light to dark through the ramp", () => {
  const lut = rampLut();
  assert.equal(lut.length, 1024);
  assert.deepEqual([lut[0], lut[1], lut[2], lut[3]], [0xfd, 0xf1, 0xe4, 255]);
  assert.deepEqual([lut[1020], lut[1021], lut[1022]], [0x86, 0x31, 0x1a]);
  assert.equal(RAMP.length, 9);
});

test("tiles built by the operator decode to the same terrain, and render", () => {
  const m = metresPerDegree(LAT);
  const elevation = (lat: number, lon: number) => {
    const e = (lon - LON) * m.lon;
    const n = (lat - LAT) * m.lat;
    return 1300 - 0.35 * e + 0.25 * n + 50 * Math.sin(e / 350) * Math.cos(n / 280) + 700 * Math.exp(-(((e - 900) / 250) ** 2));
  };
  const d = domainFor(LAT, LON, 1).bounds;
  const fine = gridFromFunction(elevation, { south: d.south - 0.002, north: d.north + 0.002, west: d.west - 0.003, east: d.east + 0.003, dLon: 1 / 10800, dLat: 1 / 10800 });
  const coarse = gridFromFunction(elevation, { south: d.south - 0.03, north: d.north + 0.03, west: d.west - 0.04, east: d.east + 0.04, dLon: 1 / 3600, dLat: 1 / 3600 });
  const { index, tiles } = buildSolarTerrain({ slug: "cervidae-peak", latitude: LAT, longitude: LON }, {
    fine, coarse, radiusKm: 1, maxDistanceKm: 2, sources: { surface: { id: "a" }, horizon: { id: "b" } },
  });
  const X = Math.floor(lonToX(LON, 14));
  const Y = Math.floor(latToY(LAT, 14));
  const file = tiles.find((t: { z: number; x: number; y: number }) => t.z === 14 && t.x === X >> 8 && t.y === Y >> 8);
  assert.ok(file);
  const tile = decodeTile(new Uint8Array(gunzipSync(file.body)), index as unknown as SolarIndex);
  const point = pointTerrain(tile, X & 255, Y & 255);
  assert.ok(point);
  const slope = (Math.acos(point.nz) * 180) / Math.PI;
  const aspect = ((Math.atan2(point.nx, point.ny) * 180) / Math.PI + 360) % 360;
  assert.ok(Math.abs(slope - index.launch.slopeDeg) < 0.6, `slope ${slope} vs ${index.launch.slopeDeg}`);
  assert.ok(Math.abs(aspect - index.launch.aspectDeg) < 2, `aspect ${aspect} vs ${index.launch.aspectDeg}`);
  assert.ok(Math.abs(point.svf - index.launch.skyViewFactor) < 0.005);
  index.launch.horizonDeg.forEach((h: number, i: number) => assert.ok(Math.abs(point.horizonsDeg[i] - h) < 0.2, `horizon ${i * 20}°: ${point.horizonsDeg[i]} vs ${h}`));
  assert.ok(point.horizonsDeg[4] > 10, "the ridge to the east shows in the horizon");

  // Morning, low sun in the east: the ridge shades the launch; early afternoon it is lit.
  const frameAt = (iso: string): Frame => {
    const sun = sunPosition(Date.parse(iso), LAT, LON);
    return { elevationDeg: sun.elevationDeg, azimuthDeg: sun.azimuthDeg, sun: sunVector(sun), sky: clearSky(sun, 1300) };
  };
  const morning = frameAt("2026-09-30T14:30:00Z");
  const afternoon = frameAt("2026-09-30T20:00:00Z");
  assert.ok(morning.elevationDeg < point.horizonsDeg[5], "sun below the ridge at 8:30");
  const shaded = pointIrradiance(point, morning);
  const lit = pointIrradiance(point, afternoon);
  assert.ok(shaded < 120 && lit > 500, `shaded ${shaded}, lit ${lit}`);

  const rgba = new Uint8ClampedArray(tile.size * tile.size * 4);
  const lut = rampLut();
  renderTile(tile, afternoon, rgba, lut, 1000);
  const o = ((Y & 255) * tile.size + (X & 255)) * 4;
  const k = Math.min(255, Math.floor((lit * 255) / 1000)) * 4;
  assert.deepEqual([...rgba.subarray(o, o + 4)], [lut[k], lut[k + 1], lut[k + 2], 255]);
});
