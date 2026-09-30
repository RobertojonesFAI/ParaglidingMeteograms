// The weather station's last hours as small multiples on one 5-minute axis:
//   Wind (mph):          5-minute mean wind and peak gust, with the launch's
//                        speed range, gust limit and a row of direction arrows
//                        marked in/out of the launch's wind window
//   Temperature (°F):    temperature and dew point
//   Sunshine (W/m²):     solar radiation reaching the station

import { HourlyChart, niceMax, type ChartSpec } from "./hourly-chart.ts";
import { compassPoint, inArc } from "./launches.ts";
import { windExtras, type ChartLaunch } from "./nws-chart.ts";
import type { StationInterval } from "./station.ts";
import { fahrenheit, fmt, mph } from "./units.ts";

const inHg = (hpa: number | null) => (hpa == null ? null : hpa / 33.8639);
const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);

/** Axis bounds for temperatures in °F: 10° steps around the data, at least 20° tall. */
export function temperatureAxis(values: (number | null)[]) {
  const known = values.filter((v): v is number => v != null);
  if (known.length === 0) return { yMin: 30, yMax: 80, yStep: 10 };
  let yMin = Math.floor(Math.min(...known) / 10) * 10;
  let yMax = Math.ceil(Math.max(...known) / 10) * 10;
  if (yMax - yMin < 20) yMax = yMin + 20;
  if (yMax === Math.max(...known)) yMax += 10;
  return { yMin, yMax, yStep: 10 };
}

export function stationSpec(launch: ChartLaunch, stationName: string): ChartSpec<StationInterval> {
  return {
    emptyText: `No reports from the ${stationName} station in the last 12 hours.`,
    minutesPerPoint: 5,
    label: `${stationName} station, last 12 hours in 5-minute steps. Use the left and right arrow keys to step through them.`,
    panels(points) {
      const wind = points.map((p) => mph(p.windSpeedMps));
      const gust = points.map((p) => mph(p.windGustMps));
      const windTop = niceMax(Math.max(launch.gustMaxMph + 5, ...[...wind, ...gust].map((v) => v ?? 0)), 5);
      const temperature = points.map((p) => fahrenheit(p.temperatureC));
      const dewPoint = points.map((p) => fahrenheit(p.dewPointC));
      const sun = points.map((p) => p.solarRadiationWm2);
      const extras = windExtras(launch, points.map((p) => p.windDirectionDeg));
      return [
        {
          title: "Wind at the station",
          unit: "mph",
          height: 170,
          yMax: windTop,
          yStep: windTop > 40 ? 10 : 5,
          series: [
            { key: "wind", label: "Wind", color: "var(--series-1)", values: wind },
            { key: "gust", label: "Gust", color: "var(--series-2)", values: gust },
          ],
          band: extras.band,
          limit: extras.limit,
          arrows: extras.arrows,
          legend: [
            { label: "Wind (5-min mean)", kind: "line", color: "var(--series-1)" },
            { label: "Gust (5-min peak)", kind: "line", color: "var(--series-2)" },
            ...extras.legendTail,
          ],
        },
        {
          title: "Temperature",
          unit: "°F",
          height: 110,
          ...temperatureAxis([...temperature, ...dewPoint]),
          series: [
            { key: "temperature", label: "Temp", color: "var(--series-1)", values: temperature },
            { key: "dew", label: "Dew pt", color: "var(--series-2)", values: dewPoint },
          ],
          legend: [
            { label: "Temperature", kind: "line", color: "var(--series-1)" },
            { label: "Dew point", kind: "line", color: "var(--series-2)" },
          ],
        },
        {
          title: "Sunshine",
          unit: "W/m²",
          height: 100,
          yMax: niceMax(Math.max(400, ...sun.map((v) => v ?? 0)), 200),
          yStep: 200,
          series: [{ key: "sun", label: "Sunshine", color: "var(--series-1)", values: sun, area: true }],
        },
      ];
    },
    tooltip(p) {
      const inWindow = p.windDirectionDeg != null && inArc(p.windDirectionDeg, launch.window);
      return [
        { label: "Wind", value: `${dir(p.windDirectionDeg)}${fmt(mph(p.windSpeedMps))} mph`, color: "var(--series-1)", extra: inWindow ? "✓" : undefined },
        { label: "Gust", value: `${fmt(mph(p.windGustMps))} mph`, color: "var(--series-2)" },
        { label: "Temperature", value: `${fmt(fahrenheit(p.temperatureC))}°F` },
        { label: "Dew point", value: `${fmt(fahrenheit(p.dewPointC))}°F` },
        { label: "Humidity", value: `${fmt(p.humidityPct)}%` },
        { label: "Pressure", value: `${fmt(inHg(p.pressureHpa), 2)} inHg` },
        { label: "Sunshine", value: `${fmt(p.solarRadiationWm2)} W/m²` },
      ];
    },
    note: (p) => (p.windSpeedMps == null && p.temperatureC == null ? "No report" : null),
    table: {
      columns: ["Wind (mph)", "Gust", "Temp", "Dew pt", "Humidity", "Pressure (inHg)", "Sun (W/m²)"],
      cells(p) {
        const inWindow = p.windDirectionDeg != null && inArc(p.windDirectionDeg, launch.window);
        return [
          `${dir(p.windDirectionDeg)}${fmt(mph(p.windSpeedMps))}${inWindow ? " ✓" : ""}`,
          fmt(mph(p.windGustMps)),
          `${fmt(fahrenheit(p.temperatureC))}°F`,
          `${fmt(fahrenheit(p.dewPointC))}°F`,
          `${fmt(p.humidityPct)}%`,
          fmt(inHg(p.pressureHpa), 2),
          fmt(p.solarRadiationWm2),
        ];
      },
      footnote: `5-minute steps: mean wind and peak gust. ✓ = wind from the launch's window (${launch.windowLabel}).`,
    },
  };
}

export class StationChart extends HourlyChart<StationInterval> {
  constructor(root: HTMLElement, launch: ChartLaunch, stationName: string, timeZone: string) {
    super(root, stationSpec(launch, stationName), timeZone);
  }
}
