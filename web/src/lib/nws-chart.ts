// Hourly NWS forecast as three small-multiple panels sharing one hour axis:
//   Wind (mph):         surface wind, gusts, transport wind; the launch's speed
//                       range as a band, the gust limit as a line, and a row of
//                       direction arrows marked in/out of the launch's wind window
//   Mixing height (ft): single series, area wash
//   Clouds & storms (%): sky cover, chance of precipitation, chance of thunder

import { HourlyChart, niceMax, type ChartSpec } from "./hourly-chart.ts";
import { compassPoint, inArc, type DirectionArc } from "./launches.ts";
import { fahrenheit, fmt, ft, mph } from "./units.ts";

export interface NwsHour {
  validAt: string;
  temperatureC: number | null;
  skyCoverPct: number | null;
  windDirectionDeg: number | null;
  windSpeedMps: number | null;
  windGustMps: number | null;
  precipitationProbabilityPct: number | null;
  thunderProbabilityPct: number | null;
  mixingHeightM: number | null;
  transportWindDirectionDeg: number | null;
  transportWindSpeedMps: number | null;
  shortForecast: string | null;
}

export interface ChartLaunch {
  windMinMph: number;
  windMaxMph: number;
  gustMaxMph: number;
  window: DirectionArc;
  windowLabel: string;
}

const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);

/** The launch's wind panel pieces shared by every hourly chart. */
export function windExtras(launch: ChartLaunch, directions: (number | null)[]) {
  return {
    band: { from: launch.windMinMph, to: launch.windMaxMph },
    limit: launch.gustMaxMph,
    arrows: directions.map((deg) => ({ deg, inWindow: deg != null && inArc(deg, launch.window) })),
    legendTail: [
      { label: `Launch range ${launch.windMinMph}–${launch.windMaxMph} mph`, kind: "band" as const, color: "var(--good)" },
      { label: `Gust limit ${launch.gustMaxMph} mph`, kind: "limit" as const, color: "var(--critical)" },
      { label: `Wind from ${launch.windowLabel}`, kind: "arrow-in" as const, color: "var(--good)" },
      { label: "Wind from other directions", kind: "arrow-out" as const, color: "var(--muted)" },
    ],
  };
}

/** Axis top and step for a height panel in feet: ticks must divide the top so it is labelled. */
export function feetAxis(values: (number | null)[]) {
  const peak = Math.max(2000, ...values.map((v) => v ?? 0));
  const step = peak > 8000 ? 4000 : 2000;
  return { yMax: niceMax(peak, step), yStep: step };
}

export function nwsSpec(launch: ChartLaunch): ChartSpec<NwsHour> {
  return {
    emptyText: "The National Weather Service forecast does not cover this day yet.",
    panels(hours) {
      const wind = hours.map((h) => mph(h.windSpeedMps));
      const gust = hours.map((h) => mph(h.windGustMps));
      const transport = hours.map((h) => mph(h.transportWindSpeedMps));
      const windTop = niceMax(Math.max(launch.gustMaxMph + 5, ...[...wind, ...gust, ...transport].map((v) => v ?? 0)), 5);
      const mixing = hours.map((h) => ft(h.mixingHeightM));
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
            { key: "transport", label: "Transport", color: "var(--series-3)", values: transport },
          ],
          band: extras.band,
          limit: extras.limit,
          arrows: extras.arrows,
          legend: [
            { label: "Wind (10 m)", kind: "line", color: "var(--series-1)" },
            { label: "Gust", kind: "line", color: "var(--series-2)" },
            { label: "Transport wind (mixed layer)", kind: "line", color: "var(--series-3)" },
            ...extras.legendTail,
          ],
        },
        {
          title: "Mixing height",
          unit: "ft above ground",
          height: 130,
          ...feetAxis(mixing),
          series: [{ key: "mixing", label: "Mixing height", color: "var(--series-1)", values: mixing, area: true }],
        },
        {
          title: "Clouds & storms",
          unit: "%",
          height: 130,
          yMax: 100,
          yStep: 50,
          series: [
            { key: "sky", label: "Sky cover", color: "var(--series-1)", values: hours.map((h) => h.skyCoverPct) },
            { key: "precip", label: "Precipitation", color: "var(--series-2)", values: hours.map((h) => h.precipitationProbabilityPct) },
            { key: "thunder", label: "Thunder", color: "var(--series-3)", values: hours.map((h) => h.thunderProbabilityPct) },
          ],
          legend: [
            { label: "Sky cover", kind: "line", color: "var(--series-1)" },
            { label: "Chance of precipitation", kind: "line", color: "var(--series-2)" },
            { label: "Chance of thunder", kind: "line", color: "var(--series-3)" },
          ],
        },
      ];
    },
    tooltip(h) {
      const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
      return [
        { label: "Wind", value: `${dir(h.windDirectionDeg)}${fmt(mph(h.windSpeedMps))} mph`, color: "var(--series-1)", extra: inWindow ? "✓" : undefined },
        { label: "Gust", value: `${fmt(mph(h.windGustMps))} mph`, color: "var(--series-2)" },
        { label: "Transport", value: `${dir(h.transportWindDirectionDeg)}${fmt(mph(h.transportWindSpeedMps))} mph`, color: "var(--series-3)" },
        { label: "Mixing height", value: `${fmt(ft(h.mixingHeightM), 0)} ft` },
        { label: "Sky cover", value: `${fmt(h.skyCoverPct)}%` },
        { label: "Precip / thunder", value: `${fmt(h.precipitationProbabilityPct)}% / ${fmt(h.thunderProbabilityPct)}%` },
        { label: "Temperature", value: `${fmt(fahrenheit(h.temperatureC))}°F` },
      ];
    },
    note: (h) => h.shortForecast,
    table: {
      columns: ["Wind (mph)", "Gust", "Transport (mph)", "Mixing ht (ft)", "Sky", "Precip", "Thunder", "Temp", "Forecast"],
      cells(h) {
        const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
        return [
          `${dir(h.windDirectionDeg)}${fmt(mph(h.windSpeedMps))}${inWindow ? " ✓" : ""}`,
          fmt(mph(h.windGustMps)),
          `${dir(h.transportWindDirectionDeg)}${fmt(mph(h.transportWindSpeedMps))}`,
          fmt(ft(h.mixingHeightM)),
          `${fmt(h.skyCoverPct)}%`,
          `${fmt(h.precipitationProbabilityPct)}%`,
          `${fmt(h.thunderProbabilityPct)}%`,
          `${fmt(fahrenheit(h.temperatureC))}°F`,
          h.shortForecast ?? "",
        ];
      },
      textColumns: [8],
      footnote: `✓ = wind from the launch's window (${launch.windowLabel}).`,
    },
  };
}

/** The NWS panel, as used on the launch page. */
export class NwsChart extends HourlyChart<NwsHour> {
  constructor(root: HTMLElement, launch: ChartLaunch, timeZone: string) {
    super(root, nwsSpec(launch), timeZone);
  }
}
