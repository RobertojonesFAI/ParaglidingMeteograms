// Weather-balloon soundings as Skew-T soundings, read for pilots.
//
// Three sources, all for the upper-air station nearest the launch:
//   - the balloon itself (raob/sites/<slug>.json: temperature, dew point, wind);
//   - the NWS Soaring Forecast's balloon table (temperature and wind only),
//     used when the balloon file is missing;
//   - the Soaring Forecast's model hours (9 AM to 6 PM; temperature and wind).
//
// The morning balloon is read the way the Soaring Forecast is made: a thermal
// leaves the ground at the forecast high and rises along a dry adiabat until
// it is no warmer than the morning air. That height is the day's thermal top.

import {
  feet, findCloudLayers, findStableLayers, freezingLevel, liftParcel, surfacePressureHpa, thermalTop, windAtHeight,
  type Finding, type Reading, type Sounding, type SoundingPoint,
} from "./skewt.ts";
import type { Srg, SrgProfile } from "./srg.ts";
import { compassPoint } from "./launches.ts";

const FT = 3.28084;
const MPH = 2.23694;
const KT = 0.514444;
const G = 9.80665;
const RD = 287.04;
/** Display ceiling: the flyable band and a margin (about 21,000 ft). */
const TOP_HPA = 450;

export interface RaobLevel {
  pressureHpa: number;
  heightM: number;
  temperatureC: number;
  dewPointC: number | null;
  windDirectionDeg: number | null;
  windSpeedMps: number | null;
}

export interface RaobDocument {
  schemaVersion: 1;
  generatedAt: string;
  station: { id: string; name: string; latitude: number; longitude: number; distanceKm: number; elevationM: number | null };
  soundings: { validAt: string; levels: RaobLevel[] }[];
}

export type SoundingKind = "balloon" | "model";

export interface Choice {
  id: string;
  kind: SoundingKind;
  validAt: string;
  sounding: Sounding;
  /** Surface temperature the thermal starts from, and where it comes from. */
  start: { temperatureC: number; source: "forecast-high" | "observed" };
  srgProfile: SrgProfile | null;
  hasDewPoint: boolean;
}

const f = (c: number) => Math.round((c * 9) / 5 + 32);
const ftText = (m: number) => `${feet(m).toLocaleString("en-US")} ft`;

function finish(points: SoundingPoint[], validAt: string, startC: number, hasDewPoint: boolean, topLabel: string): Sounding {
  const surface = points[0];
  const { parcel, lclM } = liftParcel(points, startC, surface.dewPointC);
  const top = thermalTop(parcel);
  const thermals = top !== null && top > surface.heightM + 100;
  return {
    validAt,
    modelElevationM: surface.heightM,
    points,
    parcel,
    lclM,
    boundaryLayerTopM: thermals ? top : null,
    thermalVelocityMps: 0,
    cloudBaseM: hasDewPoint ? lclM : null,
    usableLiftTopM: thermals ? top : null,
    capeJkg: null,
    inversions: findStableLayers(points),
    cloudLayers: hasDewPoint ? findCloudLayers(points) : [],
    freezingLevelM: freezingLevel(points),
    topM: points[points.length - 1].heightM,
    hasDewPoint,
    marks: {
      zoneTopM: thermals ? top : null,
      top: thermals ? { heightM: top, label: `${topLabel} ≈ ${ftText(top)}` } : null,
      cloudBaseM: thermals && hasDewPoint && lclM !== null && lclM <= top + 100 ? lclM : null,
    },
  };
}

/** A balloon's sounding, with the thermal started from `startC` (the forecast high, or the observed surface). */
export function balloonSounding(sounding: RaobDocument["soundings"][number], startC: number | null): Sounding | null {
  const levels = sounding.levels.filter((l) => l.pressureHpa >= TOP_HPA);
  if (levels.length < 5) return null;
  const points: SoundingPoint[] = levels.map((l, i) => ({
    pressureHpa: l.pressureHpa,
    heightM: l.heightM,
    temperatureC: l.temperatureC,
    dewPointC: l.dewPointC ?? Number.NaN,
    windSpeedMps: l.windSpeedMps,
    windDirectionDeg: l.windDirectionDeg,
    surface: i === 0,
  }));
  const hasDew = points.filter((p) => Number.isFinite(p.dewPointC)).length >= points.length / 2;
  return finish(points, sounding.validAt, Math.max(startC ?? points[0].temperatureC, points[0].temperatureC), hasDew, "Thermals to");
}

/** A Soaring Forecast table (balloon or model hour) as a sounding: heights in feet, pressure from the hypsometric equation. */
export function srgSounding(profile: SrgProfile, stationElevationM: number, startC: number | null): Sounding | null {
  const rows = profile.rows.filter((r) => r.heightFt / FT >= stationElevationM - 30);
  if (rows.length < 5) return null;
  // Surface pressure from the standard atmosphere; a few hPa off changes nothing visible.
  let p = 1013.25 * (1 - 2.25577e-5 * (rows[0].heightFt / FT)) ** 5.25588;
  const points: SoundingPoint[] = [];
  rows.forEach((r, i) => {
    const z = r.heightFt / FT;
    if (i > 0) {
      const below = points[i - 1];
      p *= Math.exp((-G * (z - below.heightM)) / (RD * ((below.temperatureC + r.temperatureC) / 2 + 273.15)));
    }
    points.push({
      pressureHpa: p,
      heightM: z,
      temperatureC: r.temperatureC,
      dewPointC: Number.NaN,
      windSpeedMps: r.windSpeedKt === null ? null : r.windSpeedKt * KT,
      windDirectionDeg: r.windDirectionDeg,
      surface: i === 0,
    });
  });
  const kept = points.filter((pt) => pt.pressureHpa >= TOP_HPA);
  return finish(kept, profile.validAt, Math.max(startC ?? kept[0].temperatureC, kept[0].temperatureC), false, "Thermals to");
}

/** Is `iso` a morning launch (before local noon) at the station? */
export const isMorning = (iso: string, timeZone: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(iso))) < 12;

const localDate = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));

/**
 * Every sounding worth showing, newest balloon first, then the Soaring
 * Forecast's model hours for its day.
 */
export function choices(doc: RaobDocument | null, srg: Srg | null, timeZone: string): Choice[] {
  const out: Choice[] = [];
  const high = (validAt: string) =>
    srg && srg.forecastMaxTempC !== null && srg.forecastDate === localDate(validAt, timeZone) && isMorning(validAt, timeZone) ? srg.forecastMaxTempC : null;
  for (const s of doc?.soundings ?? []) {
    const start = high(s.validAt);
    const sounding = balloonSounding(s, start);
    if (!sounding) continue;
    out.push({
      id: `balloon-${s.validAt}`,
      kind: "balloon",
      validAt: s.validAt,
      sounding,
      start: start !== null ? { temperatureC: start, source: "forecast-high" } : { temperatureC: sounding.points[0].temperatureC, source: "observed" },
      srgProfile: srg?.observed?.validAt === s.validAt ? srg.observed : null,
      hasDewPoint: sounding.hasDewPoint,
    });
  }
  const elevationM = (srg?.stationElevationFt ?? 0) / FT || doc?.station.elevationM || 0;
  // No balloon file: fall back to the Soaring Forecast's own balloon table.
  if (out.length === 0 && srg?.observed && elevationM) {
    const start = high(srg.observed.validAt);
    const sounding = srgSounding(srg.observed, elevationM, start);
    if (sounding) {
      out.push({
        id: `balloon-${srg.observed.validAt}`,
        kind: "balloon",
        validAt: srg.observed.validAt,
        sounding,
        start: start !== null ? { temperatureC: start, source: "forecast-high" } : { temperatureC: sounding.points[0].temperatureC, source: "observed" },
        srgProfile: srg.observed,
        hasDewPoint: false,
      });
    }
  }
  for (const m of srg?.model ?? []) {
    if (!elevationM) break;
    const sounding = srgSounding(m, elevationM, null);
    if (!sounding) continue;
    out.push({ id: `model-${m.validAt}`, kind: "model", validAt: m.validAt, sounding, start: { temperatureC: sounding.points[0].temperatureC, source: "observed" }, srgProfile: m, hasDewPoint: false });
  }
  return out;
}

function liWords(li: number): { text: string; tone: Finding["tone"] } {
  if (li >= 3) return { text: "very stable aloft: no storm risk", tone: "good" };
  if (li >= 0) return { text: "stable aloft: storms unlikely", tone: "good" };
  if (li >= -3) return { text: "slightly unstable: cumulus can build, watch them", tone: "caution" };
  if (li >= -6) return { text: "unstable: thunderstorms possible", tone: "warning" };
  return { text: "very unstable: thunderstorms likely", tone: "warning" };
}

const SOARING_TONE: Record<string, Finding["tone"]> = { excellent: "good", good: "good", fair: "neutral", poor: "caution", none: "caution" };

/** What a balloon or model-hour sounding means for a pilot launching at `launchM`. */
export function readChoice(choice: Choice, srg: Srg | null, launchM: number | null, timeZone: string): Reading {
  const s = choice.sounding;
  const findings: Finding[] = [];
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const top = s.marks.zoneTopM;
  const station = s.modelElevationM;
  const fromHigh = choice.start.source === "forecast-high";
  const morning = choice.kind === "balloon" && isMorning(choice.validAt, timeZone);

  // Thermals
  if (top !== null) {
    const lead = fromHigh
      ? `If it warms to the forecast high of ${f(choice.start.temperatureC)} °F, thermals should rise to about ${ftText(top)} (${feet(top - station).toLocaleString("en-US")} ft above the station).`
      : choice.kind === "model"
        ? `At ${time.format(new Date(choice.validAt))} the NWS model has thermals from ${f(choice.start.temperatureC)} °F at the ground reaching about ${ftText(top)}.`
        : `The air was mixed up to about ${ftText(top)} when the balloon went up: roughly how high thermals reached.`;
    let text = lead;
    if (fromHigh && srg?.maxThermalHeightFt) text += ` The NWS puts it at ${srg.maxThermalHeightFt.toLocaleString("en-US")} ft${srg.maxLiftFpm ? `, with lift up to ${srg.maxLiftFpm} ft/min` : ""}.`;
    const tone = fromHigh && srg?.soaringIndex ? SOARING_TONE[srg.soaringIndex.toLowerCase()] ?? "neutral" : "neutral";
    findings.push({ key: "thermals", title: fromHigh && srg?.soaringIndex ? `Thermals: ${srg.soaringIndex}` : "Thermals", text, tone });
  } else {
    findings.push({
      key: "thermals",
      title: "Thermals",
      text: morning && !fromHigh ? "Morning air: a thermal from the ground's current temperature would not rise. The afternoon forecast high decides the day." : `A thermal from ${f(choice.start.temperatureC)} °F at the ground would not rise: no thermals at this hour.`,
      tone: "neutral",
    });
  }

  // Trigger (the morning Soaring Forecast)
  if (fromHigh && srg?.triggerTempC != null) {
    findings.push({
      key: "thermals",
      title: "When they start",
      text: `Usable thermals start once it reaches ${f(srg.triggerTempC)} °F${srg.triggerTime ? `, around ${time.format(new Date(srg.triggerTime))}` : ""} (NWS).`,
      tone: "neutral",
    });
  }

  // Launch
  if (launchM !== null && top !== null) {
    if (top < launchM + 150) {
      findings.push({ key: "top", title: "Your launch", text: `Thermals top out at or below your launch (${ftText(launchM)}): expect little lift above launch.`, tone: "caution" });
    } else {
      findings.push({ key: "top", title: "Your launch", text: `From your launch at ${ftText(launchM)}, that is about ${feet(top - launchM).toLocaleString("en-US")} ft of climb.`, tone: "good" });
    }
  }

  // Clouds
  if (choice.hasDewPoint && top !== null && s.lclM !== null) {
    findings.push(
      s.lclM <= top + 100
        ? { key: "clouds", title: "Clouds", text: `Thermals reach condensation: cumulus with a base around ${ftText(s.lclM)}.`, tone: "good" }
        : { key: "clouds", title: "Clouds", text: `Blue: the air would need to rise to about ${ftText(s.lclM)} to make cloud, above the thermals.`, tone: "neutral" },
    );
  } else if (!choice.hasDewPoint) {
    findings.push({ key: "clouds", title: "Clouds", text: "This table has no humidity, so it cannot show clouds.", tone: "neutral" });
  }
  const deck = s.cloudLayers.find((l) => !l.grounded);
  if (deck) findings.push({ key: "clouds", title: "Cloud layer", text: `The balloon found nearly saturated air between ${ftText(deck.baseM)} and ${ftText(deck.topM)}.`, tone: "caution" });

  // Lids
  const grounded = s.inversions.find((l) => l.grounded);
  if (grounded) {
    findings.push({
      key: "lid",
      title: "Valley inversion",
      text: `Cold air near the ground up to about ${ftText(grounded.topM)}${morning ? ": typical after a clear night. It has to warm through before thermals start" : ""}.`,
      tone: "neutral",
    });
  }
  const lid = s.inversions.find((l) => !l.grounded && l.baseM <= (top ?? station) + 600);
  if (lid) findings.push({ key: "lid", title: lid.kind === "inversion" ? "Inversion" : "Stable layer", text: `${lid.kind === "inversion" ? "An inversion" : "A stable layer"} from ${ftText(lid.baseM)} to ${ftText(lid.topM)} caps the thermals.`, tone: "neutral" });

  // Wind
  const at = (z: number) => windAtHeight(s.points, z);
  const words = (w: { speedMps: number; directionDeg: number } | null) => (!w ? "–" : w.speedMps * MPH < 2 ? "calm" : `${compassPoint(w.directionDeg)} ${Math.round(w.speedMps * MPH)} mph`);
  const heights = [launchM ?? station + 600, top ?? station + 2000];
  const [low, high2] = heights.map(at);
  if (low && high2) {
    const strong = high2.speedMps * MPH > 20;
    findings.push({
      key: "wind",
      title: "Wind",
      text: `At launch height (${ftText(heights[0])}): ${words(low)}. At ${ftText(heights[1])}: ${words(high2)}.${strong ? " Strong wind up high: drift and broken thermals." : ""}`,
      tone: strong ? "warning" : "neutral",
    });
  }

  // Stability and storms
  const li = choice.srgProfile?.liftedIndex ?? null;
  if (li !== null) {
    const w = liWords(li);
    const cape = choice.srgProfile?.capeJkg;
    findings.push({ key: "storms", title: "Storms", text: `Lifted index ${li > 0 ? "+" : ""}${li}: ${w.text}.${cape != null && cape > 0 ? ` CAPE ${Math.round(cape)} J/kg.` : ""}`, tone: w.tone });
  }
  if (fromHigh && srg?.overdevelopment && srg.overdevelopment.toLowerCase() !== "none") {
    findings.push({ key: "storms", title: "Overdevelopment", text: `The NWS expects cumulus to overdevelop around ${srg.overdevelopment}.`, tone: "warning" });
  }
  if (s.freezingLevelM !== null && s.freezingLevelM > station + 100) {
    findings.push({ key: "stability", title: "Freezing level", text: `The air is below freezing above about ${ftText(s.freezingLevelM)}.`, tone: "neutral" });
  }

  let headline: string;
  if (top === null) headline = "No thermals in this sounding.";
  else if (fromHigh) headline = `If it reaches ${f(choice.start.temperatureC)} °F: thermals to about ${ftText(top)}${choice.hasDewPoint && s.lclM !== null ? (s.lclM <= top + 100 ? `, cumulus base about ${ftText(s.lclM)}` : ", blue") : ""}.`;
  else headline = `Thermals to about ${ftText(top)} at ${time.format(new Date(choice.validAt))}.`;
  return { headline, findings };
}
