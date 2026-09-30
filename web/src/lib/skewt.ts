// One hour of a model profile as a sounding, and what it means for a pilot.
//
// The thermodynamics come from @azohra/meteo.briefing (the same lifted
// parcel and derived heights the soaring meteogram uses), so the Skew-T and
// the meteogram always agree. This module adds what a Skew-T reader looks
// for: inversions, cloud layers, the freezing level, winds at launch and at
// the top of the lift, and a plain-language reading of all of it.

import type { SiteForecast } from "@azohra/meteo.briefing/contract";
import { lapseRateCPer1000Ft, parcelAscent, stabilityClass, windToComponents, componentsToWind } from "@azohra/meteo.briefing/derive";
import { compassPoint } from "./launches.ts";

type Hour = SiteForecast["hours"][number];
type Value = number | { p50: number | null } | null | undefined;

const G = 9.80665;
const RD = 287.04;
const FT = 3.28084;
const MPH = 2.23694;

/** Scalar value of a field: the number itself, or the ensemble median. */
export function scalar(v: Value): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && typeof v.p50 === "number") return v.p50;
  return null;
}

export interface SoundingPoint {
  pressureHpa: number;
  heightM: number;
  temperatureC: number;
  dewPointC: number;
  windSpeedMps: number | null;
  windDirectionDeg: number | null;
  /** The surface (2 m / 10 m) values at model elevation. */
  surface: boolean;
}

export interface ParcelSample {
  pressureHpa: number;
  heightM: number;
  parcelC: number;
  environmentC: number;
  /** Parcel minus environment, virtual temperature: positive = a thermal here still rises. */
  buoyancyC: number;
}

export interface Layer {
  baseM: number;
  topM: number;
  kind: "inversion" | "stable" | "cloud";
  /** For inversions: warming across the layer, degC. */
  strengthC?: number;
  /** True when the layer starts at the ground. */
  grounded?: boolean;
}

export interface Sounding {
  validAt: string;
  modelElevationM: number;
  /** Surface first, then the published levels upward. */
  points: SoundingPoint[];
  parcel: ParcelSample[];
  lclM: number | null;
  boundaryLayerTopM: number | null;
  thermalVelocityMps: number;
  cloudBaseM: number | null;
  usableLiftTopM: number | null;
  /** Surface-based CAPE the model published, J/kg. */
  capeJkg: number | null;
  inversions: Layer[];
  cloudLayers: Layer[];
  freezingLevelM: number | null;
  /** Highest published level. */
  topM: number;
}

// ── building ────────────────────────────────────────────────────────────────

/** Surface pressure from the lowest level by the hypsometric equation. */
export function surfacePressureHpa(surface: { heightM: number; temperatureC: number }, level: { pressureHpa: number; heightM: number; temperatureC: number }) {
  const meanK = (surface.temperatureC + level.temperatureC) / 2 + 273.15;
  return level.pressureHpa * Math.exp((G * (level.heightM - surface.heightM)) / (RD * meanK));
}

/** The sounding for one hour, or null when the hour has too few levels to draw. */
export function buildSounding(profile: Pick<SiteForecast, "site">, hour: Hour): Sounding | null {
  const zs = profile.site.modelElevationM;
  const s = hour.surface;
  const ts = scalar(s.temperatureC);
  const tds = scalar(s.dewPointC);
  if (ts === null || tds === null) return null;

  const levels: SoundingPoint[] = [];
  for (const l of hour.levels ?? []) {
    const p = scalar(l.pressureHpa);
    const z = scalar(l.heightM);
    const t = scalar(l.temperatureC);
    const td = scalar(l.dewPointC);
    if (p === null || z === null || t === null || td === null || z <= zs + 5) continue;
    levels.push({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: Math.min(td, t), windSpeedMps: scalar(l.windSpeedMps), windDirectionDeg: scalar(l.windDirectionDeg), surface: false });
  }
  levels.sort((a, b) => a.heightM - b.heightM);
  if (levels.length < 2) return null;

  const surface: SoundingPoint = {
    pressureHpa: surfacePressureHpa({ heightM: zs, temperatureC: ts }, levels[0]),
    heightM: zs,
    temperatureC: ts,
    dewPointC: Math.min(tds, ts),
    windSpeedMps: scalar(s.windSpeedMps),
    windDirectionDeg: scalar(s.windDirectionDeg),
    surface: true,
  };
  const points = [surface, ...levels];
  const topM = levels[levels.length - 1].heightM;

  // A dense parcel, every 25 m, so its dry leg draws as the curve it is.
  const dense: { heightM: number; temperatureC: number; dewPointC: number }[] = [];
  for (let z = zs + 25; z < topM; z += 25) {
    const env = environmentAtHeight(points, z);
    dense.push({ heightM: z, temperatureC: env.temperatureC, dewPointC: env.dewPointC });
  }
  for (const l of levels) dense.push({ heightM: l.heightM, temperatureC: l.temperatureC, dewPointC: l.dewPointC });
  dense.sort((a, b) => a.heightM - b.heightM);
  const ascent = parcelAscent({ temperatureC: ts, dewPointC: surface.dewPointC, elevationM: zs }, dense);
  const parcel: ParcelSample[] = [
    { pressureHpa: surface.pressureHpa, heightM: zs, parcelC: ts, environmentC: ts, buoyancyC: 0 },
    ...ascent.levels.map((sample) => ({
      pressureHpa: pressureAtHeight(points, sample.heightM),
      heightM: sample.heightM,
      parcelC: sample.parcelTempC,
      environmentC: sample.envTempC,
      buoyancyC: sample.buoyancyC,
    })),
  ];

  const d = hour.derived;
  return {
    validAt: hour.validAt,
    modelElevationM: zs,
    points,
    parcel,
    lclM: ascent.lclM,
    boundaryLayerTopM: scalar(d.boundaryLayerTopM),
    thermalVelocityMps: scalar(d.thermalVelocityMps) ?? 0,
    cloudBaseM: scalar(d.cloudBaseM),
    usableLiftTopM: scalar(d.usableLiftTopM),
    capeJkg: scalar(s.capeJkg),
    inversions: findStableLayers(points),
    cloudLayers: findCloudLayers(points),
    freezingLevelM: freezingLevel(points),
    topM,
  };
}

// ── interpolation (linear in log-pressure, as the chart draws) ──────────────

function bracket(points: SoundingPoint[], z: number) {
  let i = 0;
  while (i < points.length - 2 && points[i + 1].heightM < z) i += 1;
  const a = points[i];
  const b = points[i + 1];
  return { a, b, f: (z - a.heightM) / (b.heightM - a.heightM) };
}

export function pressureAtHeight(points: SoundingPoint[], z: number) {
  const { a, b, f } = bracket(points, z);
  return Math.exp(Math.log(a.pressureHpa) + f * (Math.log(b.pressureHpa) - Math.log(a.pressureHpa)));
}

export function heightAtPressure(points: SoundingPoint[], p: number) {
  let i = 0;
  while (i < points.length - 2 && points[i + 1].pressureHpa > p) i += 1;
  const a = points[i];
  const b = points[i + 1];
  const f = (Math.log(p) - Math.log(a.pressureHpa)) / (Math.log(b.pressureHpa) - Math.log(a.pressureHpa));
  return a.heightM + f * (b.heightM - a.heightM);
}

export function environmentAtHeight(points: SoundingPoint[], z: number) {
  const { a, b, f } = bracket(points, z);
  const lerp = (x: number, y: number) => x + f * (y - x);
  return { temperatureC: lerp(a.temperatureC, b.temperatureC), dewPointC: lerp(a.dewPointC, b.dewPointC) };
}

/** Wind at a height, interpolated as vectors between the points that have wind. */
export function windAtHeight(points: SoundingPoint[], z: number): { speedMps: number; directionDeg: number } | null {
  const known = points.filter((p) => p.windSpeedMps !== null && p.windDirectionDeg !== null);
  if (known.length === 0) return null;
  if (z <= known[0].heightM) return { speedMps: known[0].windSpeedMps!, directionDeg: known[0].windDirectionDeg! };
  const last = known[known.length - 1];
  if (z >= last.heightM) return { speedMps: last.windSpeedMps!, directionDeg: last.windDirectionDeg! };
  let i = 0;
  while (known[i + 1].heightM < z) i += 1;
  const a = known[i];
  const b = known[i + 1];
  const f = (z - a.heightM) / (b.heightM - a.heightM);
  const ua = windToComponents(a.windSpeedMps!, a.windDirectionDeg!);
  const ub = windToComponents(b.windSpeedMps!, b.windDirectionDeg!);
  return componentsToWind(ua.uMps + f * (ub.uMps - ua.uMps), ua.vMps + f * (ub.vMps - ua.vMps));
}

// ── features ────────────────────────────────────────────────────────────────

/**
 * Layers where temperature does not fall with height: inversions (it rises)
 * and stable, nearly isothermal layers (it falls by less than 0.3 °C per
 * 1000 ft, a tenth of a dry thermal's cooling). Both act as a lid on thermals.
 */
export function findStableLayers(points: SoundingPoint[]): Layer[] {
  const layers: Layer[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const lapse = lapseRateCPer1000Ft(a, b);
    if (lapse === null) continue;
    const kind = lapse > 0 ? "inversion" : lapse > -0.3 ? "stable" : null;
    if (!kind) continue;
    const prev = layers[layers.length - 1];
    if (prev && Math.abs(prev.topM - a.heightM) < 1) {
      prev.topM = b.heightM;
      if (kind === "inversion") prev.kind = "inversion";
      prev.strengthC = Math.max(0, (prev.strengthC ?? 0) + (b.temperatureC - a.temperatureC));
    } else {
      layers.push({ baseM: a.heightM, topM: b.heightM, kind, strengthC: Math.max(0, b.temperatureC - a.temperatureC), grounded: a.surface });
    }
  }
  return layers;
}

/** Layers where the air is within 1 °C of saturation: cloud is likely there. */
export function findCloudLayers(points: SoundingPoint[]): Layer[] {
  const layers: Layer[] = [];
  points.forEach((p, i) => {
    if (p.temperatureC - p.dewPointC > 1) return;
    const below = i > 0 ? (points[i - 1].heightM + p.heightM) / 2 : p.heightM;
    const above = i < points.length - 1 ? (points[i + 1].heightM + p.heightM) / 2 : p.heightM;
    const prev = layers[layers.length - 1];
    if (prev && prev.topM >= below - 1) prev.topM = above;
    else layers.push({ baseM: below, topM: above, kind: "cloud", grounded: p.surface });
  });
  return layers;
}

/** Lowest height where the temperature falls through 0 °C. */
export function freezingLevel(points: SoundingPoint[]): number | null {
  if (points[0].temperatureC <= 0) return points[0].heightM;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a.temperatureC > 0 && b.temperatureC <= 0) return a.heightM + ((0 - a.temperatureC) / (b.temperatureC - a.temperatureC)) * (b.heightM - a.heightM);
  }
  return null;
}

// ── plain words ─────────────────────────────────────────────────────────────

export type Tone = "good" | "neutral" | "caution" | "warning";

export interface Finding {
  key: "thermals" | "top" | "clouds" | "lid" | "wind" | "storms" | "stability";
  title: string;
  text: string;
  tone: Tone;
}

export interface Reading {
  headline: string;
  findings: Finding[];
}

export const feet = (m: number) => Math.round((m * FT) / 100) * 100;
const ftText = (m: number) => `${feet(m).toLocaleString("en-US")} ft`;
const mphText = (mps: number) => `${Math.round(mps * MPH)} mph`;
const windText = (w: { speedMps: number; directionDeg: number }) => (w.speedMps * MPH < 2 ? "calm" : `${compassPoint(w.directionDeg)} ${mphText(w.speedMps)}`);

/** Thermal strength words for Deardorff's w* (m/s). */
export function strengthWords(wStar: number): { word: string; tone: Tone } {
  if (wStar < 1) return { word: "too weak to climb in", tone: "neutral" };
  if (wStar < 1.5) return { word: "weak", tone: "neutral" };
  if (wStar < 2.5) return { word: "moderate", tone: "good" };
  if (wStar < 3.5) return { word: "strong", tone: "good" };
  return { word: "very strong, likely rough", tone: "caution" };
}

const STABILITY_WORDS: Record<string, string> = {
  "very-unstable": "very unstable: thermals are punchy and can be rough",
  unstable: "unstable: good, lively thermals",
  "conditional-strong": "unstable enough for solid thermals",
  conditional: "moderately unstable: workable thermals",
  "near-neutral": "only slightly unstable: soft, patchy thermals",
  stable: "stable: thermals struggle",
  inverted: "stable with an inversion: little or no thermal activity",
  "strong-inversion": "strongly stable: no thermals",
};

/** What the sounding means for a pilot launching at `launchM` (m MSL). */
export function readSounding(sounding: Sounding, launchM: number | null): Reading {
  const findings: Finding[] = [];
  const launch = launchM ?? sounding.modelElevationM;
  const w = sounding.thermalVelocityMps;
  const bl = sounding.boundaryLayerTopM;
  const top = sounding.usableLiftTopM;
  const hasThermals = bl !== null && w >= 0.1;

  // Thermals
  if (!hasThermals) {
    findings.push({ key: "thermals", title: "Thermals", text: "No thermals this hour: the sun is not heating the ground enough to lift the air.", tone: "neutral" });
  } else {
    const { word, tone } = strengthWords(w);
    const fpm = Math.round((w * 196.85) / 10) * 10;
    findings.push({
      key: "thermals",
      title: "Thermals",
      text: `Thermals are ${word}: about ${fpm} ft/min (w* ${w.toFixed(1)} m/s). Your climb will be a bit less once your glider's sink is taken off.`,
      tone,
    });
  }

  // Top of lift
  if (hasThermals) {
    if (top === null) {
      findings.push({ key: "top", title: "Top of lift", text: `The air mixes up to about ${ftText(bl!)}, but thermals are too weak to out-climb a glider's sink.`, tone: "neutral" });
    } else if (top <= launch + 150) {
      findings.push({ key: "top", title: "Top of lift", text: `Usable lift tops out around ${ftText(top)}, at or below launch: expect a sled ride unless the wind gives ridge lift.`, tone: "caution" });
    } else {
      findings.push({ key: "top", title: "Top of lift", text: `You can expect to climb to about ${ftText(top)}, ${feet(top - launch).toLocaleString("en-US")} ft above launch.`, tone: "good" });
    }
  }

  // Clouds
  const base = sounding.cloudBaseM;
  if (hasThermals && base !== null && base <= bl! + 100) {
    const low = base < launch + 300;
    findings.push({
      key: "clouds",
      title: "Clouds",
      text: low
        ? `Cloud base is low, about ${ftText(base)}, close to launch height: watch visibility and don't get sucked in.`
        : `Thermals reach condensation: expect cumulus with a base around ${ftText(base)}. They mark where the thermals are.`,
      tone: low ? "caution" : "good",
    });
  } else if (hasThermals) {
    findings.push({
      key: "clouds",
      title: "Clouds",
      text: `Blue day: thermals stop before the air condenses${sounding.lclM !== null ? ` (it would need about ${ftText(sounding.lclM)})` : ""}, so no cumulus will mark them.`,
      tone: "neutral",
    });
  }
  // A saturated layer at the cumulus base is the cumulus itself, not a separate deck.
  const cumulus = hasThermals && base !== null && base <= bl! + 100;
  const deck = sounding.cloudLayers.find((l) => !l.grounded && !(cumulus && l.baseM <= base! + 300));
  if (deck) {
    findings.push({ key: "clouds", title: "Cloud layer", text: `The air is nearly saturated between ${ftText(deck.baseM)} and ${ftText(deck.topM)}: a cloud layer there can shade the ground and weaken thermals.`, tone: "caution" });
  }

  // Lids
  const grounded = sounding.inversions.find((l) => l.grounded);
  if (grounded) {
    findings.push({
      key: "lid",
      title: "Ground inversion",
      text: `The air near the ground is colder than the air above it (up to about ${ftText(grounded.topM)}). Thermals only start once the sun has warmed through it.`,
      tone: "neutral",
    });
  }
  const ceiling = (hasThermals ? bl! : sounding.modelElevationM) + 600;
  const lid = sounding.inversions.find((l) => !l.grounded && l.baseM <= ceiling);
  if (lid) {
    findings.push({
      key: "lid",
      title: lid.kind === "inversion" ? "Inversion" : "Stable layer",
      text: `${lid.kind === "inversion" ? "An inversion" : "A stable layer"} from ${ftText(lid.baseM)} to ${ftText(lid.topM)} acts as a lid: thermals slow down and stop there${lid.kind === "inversion" ? ", and haze often collects under it" : ""}.`,
      tone: "neutral",
    });
  }

  // Wind
  // Aloft: the top of the lift, or about 3,000 ft above launch when there are no thermals.
  const topHeight = hasThermals ? (top ?? bl!) : launch + 900;
  const atLaunch = windAtHeight(sounding.points, launch);
  const atTop = windAtHeight(sounding.points, topHeight);
  if (atLaunch && atTop) {
    const turn = Math.abs(((atTop.directionDeg - atLaunch.directionDeg + 540) % 360) - 180);
    const shear = Math.abs(atTop.speedMps - atLaunch.speedMps) * MPH > 10 || (turn > 60 && atTop.speedMps * MPH > 8);
    const strong = atTop.speedMps * MPH > 20;
    let text = `Wind at launch height: ${windText(atLaunch)}. At ${ftText(topHeight)}: ${windText(atTop)}.`;
    if (strong) text += " Strong wind up high: expect drift and broken, turbulent thermals.";
    else if (shear) text += " The wind changes with height (shear), so thermals may lean and break up.";
    findings.push({ key: "wind", title: "Wind", text, tone: strong ? "warning" : shear ? "caution" : "neutral" });
  }

  // Storms: the model's CAPE counts energy for air lifted to condensation. On a
  // blue day the thermals themselves stop short of that, so the risk is real
  // only where something else lifts the air (higher terrain, convergence).
  const cape = sounding.capeJkg;
  if (cape !== null && cape >= 100) {
    const high = cape >= 500;
    if (cumulus) {
      findings.push({
        key: "storms",
        title: high ? "Storm risk" : "Cloud growth",
        text: high
          ? `Lots of storm energy (CAPE ${Math.round(cape)} J/kg): the cumulus can grow into thunderstorms. Watch for towering clouds and gust fronts, and land early.`
          : `Some instability above cloud base (CAPE ${Math.round(cape)} J/kg): cumulus can build. Keep an eye on them growing tall.`,
        tone: high ? "warning" : "caution",
      });
    } else if (high) {
      findings.push({
        key: "storms",
        title: "Unstable air aloft",
        text: `The air above the thermals is unstable (CAPE ${Math.round(cape)} J/kg). Thermals here stay blue, but if clouds pop over higher terrain they can grow fast into storms: watch the horizon.`,
        tone: "caution",
      });
    }
  }

  // Stability of the thermal layer
  if (hasThermals && bl! > sounding.modelElevationM + 200) {
    const env = environmentAtHeight(sounding.points, bl!);
    const lapse = lapseRateCPer1000Ft({ heightM: sounding.modelElevationM, temperatureC: sounding.points[0].temperatureC }, { heightM: bl!, temperatureC: env.temperatureC });
    if (lapse !== null) {
      const words = STABILITY_WORDS[stabilityClass(lapse)] ?? "";
      findings.push({ key: "stability", title: "Air", text: `Between the ground and the top of the thermals the air is ${words} (it cools ${Math.abs(lapse).toFixed(1)} °C per 1000 ft).`, tone: "neutral" });
    }
  }

  return { headline: headline(sounding, findings, hasThermals), findings };
}

function headline(sounding: Sounding, findings: Finding[], hasThermals: boolean) {
  if (!hasThermals) return "No thermals this hour.";
  const parts: string[] = [];
  const { word } = strengthWords(sounding.thermalVelocityMps);
  const top = sounding.usableLiftTopM;
  parts.push(top !== null ? `${word[0].toUpperCase()}${word.slice(1)} thermals to about ${ftText(top)}` : `Thermals ${word}`);
  const clouds = findings.find((f) => f.key === "clouds");
  if (clouds?.title === "Clouds") parts.push(clouds.text.startsWith("Blue") ? "blue (no cumulus)" : `cumulus base about ${ftText(sounding.cloudBaseM!)}`);
  const warn = findings.find((f) => f.tone === "warning");
  let text = parts.join(", ");
  if (warn) text += `. ${warn.title}: see below`;
  return `${text}.`;
}
