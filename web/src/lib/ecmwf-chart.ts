// Hourly ECMWF IFS forecast as three small-multiple panels sharing one hour axis:
//   Wind (mph):                 10 m wind, gusts, and the wind at 850 hPa (about
//                               ridge-top height around Boise); launch range,
//                               gust limit and direction arrows as on the NWS panel
//   Boundary layer (ft):        ECMWF's boundary-layer height above ground, a
//                               rough ceiling for thermals (like NWS mixing height)
//   Clouds (%):                 low, mid and high cloud layers

import { HourlyChart, niceMax, type ChartSpec } from "./hourly-chart.ts";
import { compassPoint, inArc } from "./launches.ts";
import { feetAxis, windExtras, type ChartLaunch } from "./nws-chart.ts";
import { fahrenheit, fmt, ft, ft100, mph } from "./units.ts";

export interface EcmwfHour {
  validAt: string;
  temperatureC: number | null;
  dewPointC: number | null;
  windSpeedMps: number | null;
  windDirectionDeg: number | null;
  windGustMps: number | null;
  cloudCoverPct: number | null;
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  cloudHighPct: number | null;
  precipitationMm: number | null;
  capeJkg: number | null;
  boundaryLayerHeightM: number | null;
  shortwaveWm2: number | null;
  wind850SpeedMps: number | null;
  wind850DirectionDeg: number | null;
  height850M: number | null;
  wind700SpeedMps: number | null;
  wind700DirectionDeg: number | null;
  height700M: number | null;
}

export interface EcmwfSiteDocument {
  schemaVersion: 1;
  source: string;
  generatedAt: string;
  models: { surface: { id: string; label: string; run: string | null }; aloft: { id: string; label: string; run: string | null } };
  site: { slug: string; gridLatitude: number | null; gridLongitude: number | null; gridElevationM: number | null };
  hours: EcmwfHour[];
}

const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);
const inches = (mm: number | null) => (mm == null ? null : mm / 25.4);

/** Typical height of a pressure level over the day, in feet rounded to 100, for labels. */
function levelFeet(values: (number | null)[]) {
  const known = values.filter((v): v is number => v != null);
  return known.length ? ft100(known.reduce((a, b) => a + b, 0) / known.length) : null;
}

export function ecmwfSpec(launch: ChartLaunch): ChartSpec<EcmwfHour> {
  let label850 = "Wind at 850 hPa";
  let label700 = "Wind at 700 hPa";
  return {
    emptyText: "The ECMWF forecast does not cover this day.",
    panels(hours) {
      const h850 = levelFeet(hours.map((h) => h.height850M));
      const h700 = levelFeet(hours.map((h) => h.height700M));
      label850 = h850 ? `Wind at 850 hPa (~${fmt(h850)} ft)` : "Wind at 850 hPa";
      label700 = h700 ? `Wind at 700 hPa (~${fmt(h700)} ft)` : "Wind at 700 hPa";
      const wind = hours.map((h) => mph(h.windSpeedMps));
      const gust = hours.map((h) => mph(h.windGustMps));
      const aloft = hours.map((h) => mph(h.wind850SpeedMps));
      const windTop = niceMax(Math.max(launch.gustMaxMph + 5, ...[...wind, ...gust, ...aloft].map((v) => v ?? 0)), 5);
      const bl = hours.map((h) => ft(h.boundaryLayerHeightM));
      const extras = windExtras(launch, hours.map((h) => h.windDirectionDeg));
      return [
        {
          title: "Wind",
          unit: "mph",
          height: 190,
          yMax: windTop,
          yStep: windTop > 40 ? 10 : 5,
          series: [
            { key: "wind", label: "Wind", color: "var(--series-1)", values: wind },
            { key: "gust", label: "Gust", color: "var(--series-2)", values: gust },
            { key: "aloft", label: "850 hPa", color: "var(--series-3)", values: aloft },
          ],
          band: extras.band,
          limit: extras.limit,
          arrows: extras.arrows,
          legend: [
            { label: "Wind (10 m)", kind: "line", color: "var(--series-1)" },
            { label: "Gust", kind: "line", color: "var(--series-2)" },
            { label: label850, kind: "line", color: "var(--series-3)" },
            ...extras.legendTail,
          ],
        },
        {
          title: "Boundary-layer height",
          unit: "ft above ground",
          height: 130,
          ...feetAxis(bl),
          series: [{ key: "bl", label: "Boundary layer", color: "var(--series-1)", values: bl, area: true }],
        },
        {
          title: "Clouds",
          unit: "%",
          height: 130,
          yMax: 100,
          yStep: 50,
          series: [
            { key: "low", label: "Low", color: "var(--series-1)", values: hours.map((h) => h.cloudLowPct) },
            { key: "mid", label: "Mid", color: "var(--series-2)", values: hours.map((h) => h.cloudMidPct) },
            { key: "high", label: "High", color: "var(--series-3)", values: hours.map((h) => h.cloudHighPct) },
          ],
          legend: [
            { label: "Low cloud", kind: "line", color: "var(--series-1)" },
            { label: "Mid cloud", kind: "line", color: "var(--series-2)" },
            { label: "High cloud", kind: "line", color: "var(--series-3)" },
          ],
        },
      ];
    },
    tooltip(h) {
      const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
      return [
        { label: "Wind", value: `${dir(h.windDirectionDeg)}${fmt(mph(h.windSpeedMps))} mph`, color: "var(--series-1)", extra: inWindow ? "✓" : undefined },
        { label: "Gust", value: `${fmt(mph(h.windGustMps))} mph`, color: "var(--series-2)" },
        { label: label850.replace("Wind at ", ""), value: `${dir(h.wind850DirectionDeg)}${fmt(mph(h.wind850SpeedMps))} mph`, color: "var(--series-3)" },
        { label: label700.replace("Wind at ", ""), value: `${dir(h.wind700DirectionDeg)}${fmt(mph(h.wind700SpeedMps))} mph` },
        { label: "Boundary layer", value: `${fmt(ft(h.boundaryLayerHeightM))} ft` },
        { label: "Cloud low / mid / high", value: `${fmt(h.cloudLowPct)} / ${fmt(h.cloudMidPct)} / ${fmt(h.cloudHighPct)}%` },
        { label: "Precipitation", value: `${fmt(inches(h.precipitationMm), 2)} in` },
        { label: "CAPE", value: `${fmt(h.capeJkg)} J/kg` },
        { label: "Temp / dew point", value: `${fmt(fahrenheit(h.temperatureC))} / ${fmt(fahrenheit(h.dewPointC))}°F` },
      ];
    },
    table: {
      columns: ["Wind (mph)", "Gust", "850 hPa (mph)", "700 hPa (mph)", "BL height (ft)", "Low", "Mid", "High", "Precip (in)", "CAPE", "Temp"],
      cells(h) {
        const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
        return [
          `${dir(h.windDirectionDeg)}${fmt(mph(h.windSpeedMps))}${inWindow ? " ✓" : ""}`,
          fmt(mph(h.windGustMps)),
          `${dir(h.wind850DirectionDeg)}${fmt(mph(h.wind850SpeedMps))}`,
          `${dir(h.wind700DirectionDeg)}${fmt(mph(h.wind700SpeedMps))}`,
          fmt(ft(h.boundaryLayerHeightM)),
          `${fmt(h.cloudLowPct)}%`,
          `${fmt(h.cloudMidPct)}%`,
          `${fmt(h.cloudHighPct)}%`,
          fmt(inches(h.precipitationMm), 2),
          fmt(h.capeJkg),
          `${fmt(fahrenheit(h.temperatureC))}°F`,
        ];
      },
      footnote: `✓ = wind from the launch's window (${launch.windowLabel}). Precipitation is the amount in the hour before.`,
    },
  };
}

export class EcmwfChart extends HourlyChart<EcmwfHour> {
  constructor(root: HTMLElement, launch: ChartLaunch, timeZone: string) {
    super(root, ecmwfSpec(launch), timeZone);
  }
}
