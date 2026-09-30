import { test } from "node:test";
import assert from "node:assert/strict";
import { parcelAscent } from "@azohra/meteo.briefing/derive";
import { buildSounding, feet, findCloudLayers, freezingLevel, heightAtPressure, pressureAtHeight, readSounding, surfacePressureHpa, windAtHeight, type SoundingPoint } from "../src/lib/skewt.ts";

const Z0 = 1300;

interface LevelSpec { p: number; z: number; t: number; td: number; ws?: number; wd?: number }

/** A profile hour shaped like the meteo contract (only the fields the Skew-T reads). */
function hour(surface: { t: number; td: number; ws?: number; wd?: number; cape?: number }, levels: LevelSpec[], derived: { bl: number | null; w: number; base: number; top: number | null }) {
  return {
    validAt: "2026-09-30T21:00:00Z",
    surface: {
      temperatureC: surface.t, dewPointC: surface.td, windSpeedMps: surface.ws ?? 3, windDirectionDeg: surface.wd ?? 315,
      seaLevelPressureHpa: 1015, cloudCoverPercent: 0, precipitationMmHr: 0, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 40,
      ...(surface.cape !== undefined ? { capeJkg: surface.cape } : {}),
    },
    levels: levels.map((l) => ({ pressureHpa: l.p, heightM: l.z, temperatureC: l.t, dewPointC: l.td, windSpeedMps: l.ws ?? 5, windDirectionDeg: l.wd ?? 300 })),
    derived: { boundaryLayerTopM: derived.bl, thermalVelocityMps: derived.w, cloudBaseM: derived.base, usableLiftTopM: derived.top },
  };
}
const site = { site: { id: "cervidae-peak", name: "Cervidae Peak", latitude: 43.6, longitude: -116, modelElevationM: Z0, timeZone: "America/Boise" } };

// A late-summer afternoon over the foothills: near-dry-adiabatic to ~3.4 km, an inversion above.
const CUMULUS_LEVELS: LevelSpec[] = [
  { p: 850, z: 1520, t: 22.9, td: 7.8 },
  { p: 800, z: 2030, t: 18.1, td: 6.9 },
  { p: 750, z: 2560, t: 13.2, td: 5.6 },
  { p: 700, z: 3120, t: 8.2, td: 4.9 },
  { p: 675, z: 3400, t: 5.8, td: 5.0 },
  { p: 650, z: 3700, t: 7.5, td: -9 },
  { p: 600, z: 4320, t: 3.4, td: -14, ws: 12, wd: 250 },
];

test("surface pressure follows the hypsometric equation", () => {
  const p = surfacePressureHpa({ heightM: Z0, temperatureC: 25 }, { pressureHpa: 850, heightM: 1520, temperatureC: 22.9 });
  // 220 m at ~297 K: p = 850 exp(g dz / (Rd T)) = 871.8 hPa.
  assert.ok(Math.abs(p - 871.78) < 0.05, `${p}`);
});

test("a cumulus day capped by an inversion reads as it should", () => {
  const s = buildSounding(site, hour({ t: 25, td: 8 }, CUMULUS_LEVELS, { bl: 3380, w: 2.2, base: 3340, top: 3300 }))!;
  assert.ok(s);
  assert.equal(s.points.length, 8);
  assert.ok(s.points[0].surface && s.points[0].pressureHpa > 870);
  // Heights and pressures invert each other along the column.
  assert.ok(Math.abs(heightAtPressure(s.points, pressureAtHeight(s.points, 2800)) - 2800) < 0.5);
  // The parcel samples at published levels match the library's own ascent.
  const direct = parcelAscent({ temperatureC: 25, dewPointC: 8, elevationM: Z0 }, CUMULUS_LEVELS.map((l) => ({ heightM: l.z, temperatureC: l.t, dewPointC: l.td })));
  for (const sample of direct.levels) {
    const ours = s.parcel.find((p) => Math.abs(p.heightM - sample.heightM) < 0.5)!;
    assert.ok(Math.abs(ours.parcelC - sample.parcelTempC) < 0.05, `${sample.heightM}: ${ours.parcelC} vs ${sample.parcelTempC}`);
  }
  assert.ok(s.lclM! > 3200 && s.lclM! < 3600, `LCL ${s.lclM}`);
  const inversion = s.inversions.find((l) => l.kind === "inversion")!;
  assert.equal(inversion.baseM, 3400);
  assert.equal(inversion.topM, 3700);
  assert.ok(Math.abs(inversion.strengthC! - 1.7) < 1e-9);
  assert.ok(s.cloudLayers.some((l) => l.baseM <= 3400 && l.topM >= 3400), "saturated at 675 hPa");

  const r = readSounding(s, 1268);
  const byKey = (k: string) => r.findings.filter((f) => f.key === k);
  assert.match(byKey("thermals")[0].text, /moderate: about 430 ft\/min \(w\* 2\.2 m\/s\)/);
  assert.match(byKey("top")[0].text, /climb to about 10,800 ft, 6,700 ft above launch/);
  assert.match(byKey("clouds")[0].text, /cumulus with a base around 11,000 ft/);
  assert.match(byKey("lid")[0].text, /An inversion from 11,200 ft to 12,100 ft acts as a lid/);
  assert.equal(r.headline, "Moderate thermals to about 10,800 ft, cumulus base about 11,000 ft.");
});

test("a dry day is blue, and strong wind aloft is flagged", () => {
  const levels = CUMULUS_LEVELS.map((l) => ({ ...l, td: l.td - 18, ws: l.z > 2500 ? 12 : 5 }));
  const s = buildSounding(site, hour({ t: 25, td: -10 }, levels, { bl: 3000, w: 1.8, base: 5200, top: 2800 }))!;
  const r = readSounding(s, 1268);
  assert.match(r.findings.find((f) => f.key === "clouds")!.text, /^Blue day/);
  const wind = r.findings.find((f) => f.key === "wind")!;
  assert.equal(wind.tone, "warning");
  assert.match(wind.text, /At 9,200 ft: WNW 2\d mph\. Strong wind up high/);
  assert.match(r.headline, /blue \(no cumulus\)\. Wind: see below\.$/);
});

test("a cold morning has a ground inversion and no thermals", () => {
  const levels: LevelSpec[] = [
    { p: 860, z: 1420, t: 9, td: 0 },
    { p: 850, z: 1520, t: 10, td: -1 },
    { p: 800, z: 2020, t: 7, td: -3 },
    { p: 700, z: 3090, t: -1, td: -8 },
  ];
  const s = buildSounding(site, hour({ t: 6, td: 1 }, levels, { bl: null, w: 0, base: 2300, top: null }))!;
  const grounded = s.inversions.find((l) => l.grounded)!;
  assert.equal(grounded.topM, 1520);
  const r = readSounding(s, 1268);
  assert.equal(r.headline, "No thermals this hour.");
  assert.ok(r.findings.some((f) => f.title === "Ground inversion"));
  assert.ok(!r.findings.some((f) => f.key === "top"));
  assert.ok(Math.abs(s.freezingLevelM! - (2020 + (7 / 8) * 1070)) < 1);
});

test("storm energy and a low cloud base are called out", () => {
  const s = buildSounding(site, hour({ t: 24, td: 16, cape: 950 }, CUMULUS_LEVELS.map((l) => ({ ...l, td: l.t - 2 })), { bl: 2200, w: 2.6, base: 1500, top: 1500 }))!;
  const r = readSounding(s, 1268);
  const storm = r.findings.find((f) => f.key === "storms")!;
  assert.equal(storm.tone, "warning");
  assert.match(storm.text, /CAPE 950 J\/kg/);
  assert.equal(r.findings.find((f) => f.key === "clouds")!.tone, "caution");
  assert.match(r.findings.find((f) => f.key === "clouds")!.text, /Cloud base is low/);
});

test("ensemble medians are used, and too few levels give no sounding", () => {
  const med = (v: number) => ({ members: 21, p10: v - 2, p25: v - 1, p50: v, p75: v + 1, p90: v + 2 });
  const h = hour({ t: 25, td: 8 }, CUMULUS_LEVELS, { bl: 3380, w: 2.2, base: 3340, top: 3300 }) as ReturnType<typeof hour> & Record<string, unknown>;
  const ens = { ...h, surface: { ...h.surface, temperatureC: med(25) }, levels: h.levels.map((l) => ({ ...l, temperatureC: med(l.temperatureC) })), derived: { ...h.derived, thermalVelocityMps: med(2.2) } };
  const s = buildSounding(site, ens as never)!;
  assert.equal(s.points[0].temperatureC, 25);
  assert.equal(s.thermalVelocityMps, 2.2);
  assert.equal(buildSounding(site, hour({ t: 25, td: 8 }, CUMULUS_LEVELS.slice(0, 1), { bl: null, w: 0, base: 3000, top: null }) as never), null);
});

test("wind, cloud-layer and freezing-level helpers", () => {
  const pts: SoundingPoint[] = [
    { pressureHpa: 870, heightM: 1300, temperatureC: 5, dewPointC: 4.5, windSpeedMps: 10, windDirectionDeg: 270, surface: true },
    { pressureHpa: 850, heightM: 1500, temperatureC: 2, dewPointC: 1.6, windSpeedMps: 10, windDirectionDeg: 290, surface: false },
    { pressureHpa: 800, heightM: 2000, temperatureC: -2, dewPointC: -9, windSpeedMps: null, windDirectionDeg: null, surface: false },
  ];
  const w = windAtHeight(pts, 1400)!;
  assert.ok(Math.abs(w.directionDeg - 280) < 0.5 && w.speedMps < 10 && w.speedMps > 9.8);
  assert.deepEqual(windAtHeight(pts, 3000), { speedMps: 10, directionDeg: 290 });
  const clouds = findCloudLayers(pts);
  assert.equal(clouds.length, 1);
  assert.equal(clouds[0].topM, 1750);
  assert.ok(Math.abs(freezingLevel(pts)! - (1500 + (2 / 4) * 500)) < 1e-9);
  assert.equal(feet(1000), 3300);
});

test("on a blue day, high CAPE is 'unstable air aloft', not a cumulus storm warning", () => {
  const levels = CUMULUS_LEVELS.map((l) => ({ ...l, td: l.td - 18 }));
  const s = buildSounding(site, hour({ t: 25, td: -10, cape: 800 }, levels, { bl: 3000, w: 2, base: 5200, top: 2900 }))!;
  const r = readSounding(s, 1268);
  const storm = r.findings.find((f) => f.key === "storms")!;
  assert.equal(storm.title, "Unstable air aloft");
  assert.equal(storm.tone, "caution");
  assert.ok(!r.headline.includes("see below"));
});

test("Skew-T geometry: isotherms lean right, dry thermals lean left, and a phone-width plot fits", async () => {
  const { fitGeometry, xOf, yOf, pOf } = await import("../src/lib/skewt-chart.ts");
  const s = buildSounding(site, hour({ t: 25, td: 8 }, CUMULUS_LEVELS, { bl: 3380, w: 2.2, base: 3340, top: 3300 }))!;
  const box = { left: 44, right: 340, top: 24, bottom: 466 };
  const g = fitGeometry(s, box);
  const [pb, pt] = [g.pBottom, g.pTop];
  assert.ok(xOf(g, 10, pt) > xOf(g, 10, pb), "an isotherm leans right going up");
  const dry = (p: number) => (25 + 273.15) * (p / s.points[0].pressureHpa) ** 0.2857 - 273.15;
  assert.ok(xOf(g, dry(pt), pt) < xOf(g, dry(pb), pb), "a dry adiabat leans left going up");
  for (const p of s.points) for (const t of [p.temperatureC, p.dewPointC]) {
    const x = xOf(g, t, p.pressureHpa);
    assert.ok(x >= box.left && x <= box.right, `${t} at ${p.pressureHpa} → ${x}`);
  }
  assert.ok(Math.abs(pOf(g, yOf(g, 700)) - 700) < 1e-9);
  assert.equal(yOf(g, pb), box.bottom);
});
