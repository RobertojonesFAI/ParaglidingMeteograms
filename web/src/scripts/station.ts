// "Live at the launch": the weather station next to the launch, read against
// the launch's wind limits, with its last 12 hours as a chart. The data comes
// from the Worker (/api/stations/<id>), which holds the provider's API key;
// the card refreshes itself every 2 minutes while the page is visible.

import { compassPoint, inArc, windWindow, type Launch } from "../lib/launches.ts";
import { StationChart } from "../lib/station-chart.ts";
import { historyGrid, isStale, readWind, recentGust, type StationDocument, type Tone } from "../lib/station.ts";
import { fahrenheit, fmt, mph, relativeTime } from "../lib/units.ts";

interface StationPageConfig {
  id: string;
  name: string;
  url: string;
}

const REFRESH_MS = 2 * 60_000;
const TONE_ICON: Record<Tone, string> = { good: "✓", neutral: "•", caution: "!", warning: "⚠" };
const SVG = "http://www.w3.org/2000/svg";

function start() {
  const byId = <T extends HTMLElement | SVGElement>(id: string) => document.getElementById(id) as unknown as T;
  const launch = JSON.parse(document.getElementById("launch-config")?.textContent ?? "{}") as Launch;
  const config = JSON.parse(byId<HTMLElement>("station-config").textContent ?? "{}") as StationPageConfig;
  const tz = launch.timeZone;
  const arc = windWindow(launch);
  const windowLabel = `${compassPoint(launch.facingDeg)} ±${launch.windArcHalfWidthDeg}°`;
  const limits = { window: arc, windMinMph: launch.windMinMph, windMaxMph: launch.windMaxMph, gustMaxMph: launch.gustMaxMph };
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

  const status = byId<HTMLElement>("station-status");
  const body = byId<HTMLElement>("station-body");
  let chart: StationChart | null = null;
  let doc: StationDocument | null = null;
  let fetchedAt = 0;

  drawCompassFrame(byId<SVGSVGElement>("station-compass"), arc);

  async function load() {
    fetchedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`/api/stations/${encodeURIComponent(config.id)}`, { cache: "no-store" });
    } catch {
      if (!doc) showStatus("Could not reach the station feed. It will try again in a couple of minutes.");
      return;
    }
    if (response.status === 503) {
      showStatus("Live readings from this station are not connected to the site yet.", true);
      return;
    }
    if (!response.ok) {
      if (!doc) showStatus("The station's readings are not available right now. The site will try again in a couple of minutes.", true);
      return;
    }
    doc = (await response.json()) as StationDocument;
    render();
  }

  function showStatus(text: string, withLink = false) {
    status.replaceChildren(document.createTextNode(`${text} `));
    if (withLink) {
      const a = document.createElement("a");
      a.href = config.url;
      a.textContent = "See it on Weather Underground";
      status.appendChild(a);
      status.appendChild(document.createTextNode("."));
    }
    status.hidden = false;
    body.hidden = true;
  }

  function render() {
    if (!doc) return;
    const now = Date.now();
    const current = doc.current;
    status.hidden = true;
    body.hidden = false;

    const stale = isStale(current, now);
    const wind = byId<HTMLElement>("station-wind");
    const gustLine = byId<HTMLElement>("station-gust");
    const headline = byId<HTMLElement>("station-headline");
    const checks = byId<HTMLElement>("station-checks");
    checks.replaceChildren();

    const gust = recentGust(doc, now);
    if (current && current.windSpeedMps !== null) {
      const deg = current.windDirectionDeg;
      wind.textContent = `${deg === null ? "Calm" : compassPoint(deg)} ${fmt(mph(current.windSpeedMps))} mph`;
      gustLine.textContent = gust === null ? "" : `Gusts to ${fmt(mph(gust))} mph in the last 15 min`;
      drawArrow(byId<SVGSVGElement>("station-compass"), deg, deg !== null && inArc(deg, arc), current.windSpeedMps);
    } else {
      wind.textContent = "No wind reading";
      gustLine.textContent = "";
      drawArrow(byId<SVGSVGElement>("station-compass"), null, false, 0);
    }
    byId<HTMLElement>("station-compass").classList.toggle("stale", stale);

    if (!current) {
      setHeadline(headline, "caution", "The station has not reported recently");
    } else if (stale) {
      setHeadline(headline, "caution", `No report since ${time.format(new Date(current.observedAt))}: the station may be offline`);
    } else {
      const reading = readWind(current, gust, limits, compassPoint, windowLabel);
      if (reading) {
        setHeadline(headline, reading.tone, reading.headline);
        for (const check of reading.checks) {
          const li = document.createElement("li");
          li.className = `finding finding-${check.tone}`;
          const icon = document.createElement("span");
          icon.className = "finding-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.textContent = TONE_ICON[check.tone];
          const text = document.createElement("div");
          const strong = document.createElement("strong");
          strong.textContent = check.label;
          const p = document.createElement("p");
          p.textContent = check.text;
          text.append(strong, p);
          li.append(icon, text);
          checks.appendChild(li);
        }
      } else {
        setHeadline(headline, "neutral", "No wind reading in the latest report");
      }
    }
    updateAge();

    const stats = byId<HTMLElement>("station-stats");
    stats.replaceChildren();
    const stat = (label: string, value: string) => {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      div.append(dt, dd);
      stats.appendChild(div);
    };
    if (current) {
      stat("Temperature", `${fmt(fahrenheit(current.temperatureC))}°F`);
      stat("Dew point", `${fmt(fahrenheit(current.dewPointC))}°F`);
      stat("Humidity", `${fmt(current.humidityPct)}%`);
      stat("Pressure", `${fmt(current.pressureHpa == null ? null : current.pressureHpa / 33.8639, 2)} inHg`);
      stat("Sunshine", `${fmt(current.solarRadiationWm2)} W/m²`);
      if (current.precipTodayMm) stat("Rain today", `${fmt(current.precipTodayMm / 25.4, 2)} in`);
    }

    if (!chart) {
      chart = new StationChart(byId<HTMLElement>("station-chart"), { windMinMph: launch.windMinMph, windMaxMph: launch.windMaxMph, gustMaxMph: launch.gustMaxMph, window: arc, windowLabel }, doc.station.name, tz);
    }
    const grid = historyGrid(doc.history, { hours: 12, now });
    chart.setHours(grid.some((p) => p.windSpeedMps !== null || p.temperatureC !== null) ? grid : []);
  }

  function updateAge() {
    const age = byId<HTMLElement>("station-age");
    const observedAt = doc?.current?.observedAt;
    age.textContent = observedAt ? `Reported ${time.format(new Date(observedAt))} (${relativeTime(observedAt)})` : "";
  }

  load();
  setInterval(() => {
    if (document.visibilityState === "visible") load();
  }, REFRESH_MS);
  setInterval(updateAge, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - fetchedAt > REFRESH_MS / 2) load();
  });
}

function setHeadline(node: HTMLElement, tone: Tone, text: string) {
  node.className = `station-headline finding-${tone}`;
  node.replaceChildren();
  const icon = document.createElement("span");
  icon.className = "finding-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = TONE_ICON[tone];
  node.append(icon, document.createTextNode(text));
}

// ── compass: the launch's wind window and the wind arrow ────────────────

const C = 56;
const R = 38;
const point = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)].map((v) => v.toFixed(1)).join(" ");
};

function svgEl(name: string, attrs: Record<string, string | number>, parent: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}

function drawCompassFrame(svg: SVGSVGElement, arc: { fromDeg: number; toDeg: number }) {
  svg.replaceChildren();
  const span = (arc.toDeg - arc.fromDeg + 360) % 360;
  svgEl("circle", { cx: C, cy: C, r: R, class: "compass-ring" }, svg);
  svgEl("path", { d: `M${C} ${C} L${point(arc.fromDeg, R)} A${R} ${R} 0 ${span > 180 ? 1 : 0} 1 ${point(arc.toDeg, R)} Z`, class: "compass-window" }, svg);
  for (const [label, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const) {
    const [x, y] = point(deg, R + 10).split(" ").map(Number);
    const text = svgEl("text", { x, y: y + 4, class: "compass-label", "text-anchor": "middle" }, svg);
    text.textContent = label;
  }
  svgEl("g", { class: "compass-arrow" }, svg);
}

/** Arrow from the rim the wind comes from to the centre: in the green window when the direction suits the launch. */
function drawArrow(svg: SVGSVGElement, deg: number | null, inWindow: boolean, speedMps: number) {
  const group = svg.querySelector(".compass-arrow")!;
  group.replaceChildren();
  group.setAttribute("class", `compass-arrow${inWindow ? " in-window" : ""}`);
  if (deg === null || speedMps < 0.45) {
    svgEl("circle", { cx: C, cy: C, r: 6, class: "compass-calm" }, group);
    return;
  }
  svgEl("path", { d: "M0 0 L-8 -15 L-3 -13 L-3 -36 L3 -36 L3 -13 L8 -15 Z", transform: `translate(${C} ${C}) rotate(${deg})` }, group);
}

// Last, so the module's constants above are initialised before the card draws.
if (document.getElementById("station")) start();
