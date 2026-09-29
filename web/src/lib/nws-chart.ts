// Hourly NWS forecast as three small-multiple panels sharing one hour axis:
//   Wind (mph):         surface wind, gusts, transport wind; the launch's speed
//                       range as a band, the gust limit as a line, and a row of
//                       direction arrows marked in/out of the launch's wind window
//   Mixing height (ft): single series, area wash
//   Clouds & storms (%): sky cover, chance of precipitation, chance of thunder
// Each panel has one y-axis. A crosshair and tooltip track the pointer (or the
// arrow keys) across all panels; a table view carries every value.

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

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.appendChild(node);
  return node;
}

function html<K extends keyof HTMLElementTagNameMap>(name: K, attrs: Record<string, string> = {}, text?: string, parent?: Element) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

function niceMax(value: number, step: number) {
  return Math.max(step, Math.ceil(value / step) * step);
}

interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  area?: boolean;
}

interface PanelSpec {
  title: string;
  unit: string;
  height: number;
  yMax: number;
  yStep: number;
  series: Series[];
  legend?: { label: string; kind: "line" | "band" | "limit" | "arrow-in" | "arrow-out"; color: string }[];
  band?: { from: number; to: number };
  limit?: number;
  arrows?: { deg: number | null; inWindow: boolean }[];
}

const MARGIN = { top: 10, bottom: 24, left: 44 };
const ARROW_ROW = 28;

export class NwsChart {
  private root: HTMLElement;
  private launch: ChartLaunch;
  private timeZone: string;
  private hours: NwsHour[] = [];
  private active: number | null = null;
  private crosshairs: SVGLineElement[] = [];
  private tooltip!: HTMLDivElement;
  private geometry = { left: MARGIN.left, step: 1, width: 0 };
  private observer: ResizeObserver;

  constructor(root: HTMLElement, launch: ChartLaunch, timeZone: string) {
    this.root = root;
    this.launch = launch;
    this.timeZone = timeZone;
    this.observer = new ResizeObserver(() => {
      if (this.hours.length > 0 && Math.abs(this.root.clientWidth - this.geometry.width) > 4) this.render();
    });
    this.observer.observe(root);
  }

  setHours(hours: NwsHour[]) {
    this.hours = hours;
    this.active = null;
    this.render();
  }

  private timeLabel(iso: string, withDay = false) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: this.timeZone,
      hour: "numeric",
      ...(withDay ? { weekday: "short" } : {}),
    }).format(new Date(iso));
  }

  private render() {
    const { root, hours, launch } = this;
    root.replaceChildren();
    this.crosshairs = [];
    if (hours.length === 0) {
      html("p", { class: "chart-status" }, "The National Weather Service forecast does not cover this day yet.", root);
      return;
    }

    const width = Math.max(320, root.clientWidth);
    const right = width < 560 ? 12 : 84;
    const plotWidth = width - MARGIN.left - right;
    const step = plotWidth / hours.length;
    this.geometry = { left: MARGIN.left, step, width };

    const wind = hours.map((h) => mph(h.windSpeedMps));
    const gust = hours.map((h) => mph(h.windGustMps));
    const transport = hours.map((h) => mph(h.transportWindSpeedMps));
    const windTop = niceMax(Math.max(launch.gustMaxMph + 5, ...[...wind, ...gust, ...transport].map((v) => v ?? 0)), 5);
    const mixing = hours.map((h) => ft(h.mixingHeightM));
    const mixingPeak = Math.max(2000, ...mixing.map((v) => v ?? 0));
    // Ticks must divide the top evenly so the top gridline is labelled.
    const mixingStep = mixingPeak > 8000 ? 4000 : 2000;
    const mixingTop = niceMax(mixingPeak, mixingStep);

    const panels: PanelSpec[] = [
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
        band: { from: launch.windMinMph, to: launch.windMaxMph },
        limit: launch.gustMaxMph,
        legend: [
          { label: "Wind (10 m)", kind: "line", color: "var(--series-1)" },
          { label: "Gust", kind: "line", color: "var(--series-2)" },
          { label: "Transport wind (mixed layer)", kind: "line", color: "var(--series-3)" },
          { label: `Launch range ${launch.windMinMph}–${launch.windMaxMph} mph`, kind: "band", color: "var(--good)" },
          { label: `Gust limit ${launch.gustMaxMph} mph`, kind: "limit", color: "var(--critical)" },
          { label: `Wind from ${launch.windowLabel}`, kind: "arrow-in", color: "var(--good)" },
          { label: "Wind from other directions", kind: "arrow-out", color: "var(--muted)" },
        ],
        arrows: hours.map((h) => ({
          deg: h.windDirectionDeg,
          inWindow: h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window),
        })),
      },
      {
        title: "Mixing height",
        unit: "ft above ground",
        height: 130,
        yMax: mixingTop,
        yStep: mixingStep,
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

    const group = html("div", {
      class: "nws-panels",
      tabindex: "0",
      role: "group",
      "aria-label": "Hourly forecast charts. Use the left and right arrow keys to step through hours.",
    });
    root.appendChild(group);
    for (const spec of panels) this.renderPanel(group, spec, width, right);

    this.tooltip = html("div", { class: "tooltip", role: "status", "aria-live": "polite", hidden: "" }) as HTMLDivElement;
    root.appendChild(this.tooltip);

    group.addEventListener("pointermove", (event) => this.pointer(event));
    group.addEventListener("pointerleave", () => this.show(null));
    group.addEventListener("focus", () => this.show(this.active ?? this.nowIndex()));
    group.addEventListener("blur", () => this.show(null));
    group.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const delta = event.key === "ArrowRight" ? 1 : -1;
        this.show(Math.min(this.hours.length - 1, Math.max(0, (this.active ?? this.nowIndex()) + delta)));
        event.preventDefault();
      } else if (event.key === "Escape") {
        this.show(null);
      }
    });

    this.renderTable(root);
  }

  private nowIndex() {
    const now = Date.now();
    const index = this.hours.findIndex((h) => Date.parse(h.validAt) + 3_600_000 > now);
    return index < 0 ? 0 : index;
  }

  private x(i: number) {
    return this.geometry.left + (i + 0.5) * this.geometry.step;
  }

  private renderPanel(parent: HTMLElement, spec: PanelSpec, width: number, right: number) {
    const section = html("section", { class: "nws-panel" }, undefined, parent);
    const heading = html("h3", {}, spec.title, section);
    html("span", { class: "muted" }, ` (${spec.unit})`, heading);

    if (spec.legend) {
      const legend = html("ul", { class: "legend" }, undefined, section);
      for (const item of spec.legend) {
        const li = html("li", {}, undefined, legend);
        if (item.kind === "line") html("span", { class: "key-line", style: `color:${item.color}` }, undefined, li);
        if (item.kind === "band") html("span", { class: "key-band" }, undefined, li);
        if (item.kind === "limit") html("span", { class: "key-line", style: `color:${item.color};height:0;border-top:1.5px dashed ${item.color};background:none` }, undefined, li);
        if (item.kind === "arrow-in" || item.kind === "arrow-out") {
          const svg = el("svg", { width: 12, height: 12, viewBox: "-6 -6 12 12", "aria-hidden": "true" }, li);
          el("path", { d: "M0 -5 L4 3 L0 1 L-4 3 Z", fill: item.color }, svg);
        }
        li.appendChild(document.createTextNode(item.label));
      }
    }

    const arrowRow = spec.arrows ? ARROW_ROW : 0;
    const plotHeight = spec.height;
    const height = MARGIN.top + plotHeight + arrowRow + MARGIN.bottom;
    const wrap = html("div", { class: "nws-chart" }, undefined, section);
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${spec.title} by hour` }, wrap);

    const y = (v: number) => MARGIN.top + plotHeight - (v / spec.yMax) * plotHeight;
    const left = MARGIN.left;
    const plotRight = width - right;

    if (spec.band) {
      const top = y(Math.min(spec.band.to, spec.yMax));
      el("rect", { x: left, y: top, width: plotRight - left, height: y(spec.band.from) - top, fill: "var(--good-wash)" }, svg);
    }

    for (let v = 0; v <= spec.yMax; v += spec.yStep) {
      el("line", { class: v === 0 ? "baseline" : "grid", x1: left, x2: plotRight, y1: y(v), y2: y(v) }, svg);
      const label = el("text", { class: "tick", x: left - 6, y: y(v) + 4, "text-anchor": "end" }, svg);
      label.textContent = fmt(v);
    }

    if (spec.limit !== undefined && spec.limit <= spec.yMax) {
      el("line", { x1: left, x2: plotRight, y1: y(spec.limit), y2: y(spec.limit), stroke: "var(--critical)", "stroke-width": 1.5, "stroke-dasharray": "4 3" }, svg);
    }

    // x ticks every 3 hours (every 6 when narrow)
    const every = this.geometry.step < 18 ? 6 : 3;
    this.hours.forEach((h, i) => {
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: this.timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(h.validAt)));
      if (hour % every !== 0) return;
      const label = el("text", { class: "tick", x: this.x(i), y: height - 6, "text-anchor": "middle" }, svg);
      label.textContent = this.timeLabel(h.validAt);
    });

    // series: area wash first, then lines; direct end labels when they do not collide
    const ends: { y: number; label: string }[] = [];
    for (const series of spec.series) {
      const segments: string[] = [];
      let current: string[] = [];
      series.values.forEach((v, i) => {
        if (v == null) {
          if (current.length) segments.push(current.join(" "));
          current = [];
          return;
        }
        current.push(`${current.length ? "L" : "M"}${this.x(i).toFixed(1)} ${y(Math.min(v, spec.yMax)).toFixed(1)}`);
      });
      if (current.length) segments.push(current.join(" "));
      const d = segments.join(" ");
      if (!d) continue;
      if (series.area) {
        const first = series.values.findIndex((v) => v != null);
        const last = series.values.length - 1 - [...series.values].reverse().findIndex((v) => v != null);
        el("path", { d: `${d} L${this.x(last)} ${y(0)} L${this.x(first)} ${y(0)} Z`, fill: series.color, "fill-opacity": 0.1 }, svg);
      }
      el("path", { d, fill: "none", stroke: series.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const lastIndex = series.values.length - 1 - [...series.values].reverse().findIndex((v) => v != null);
      const lastValue = series.values[lastIndex];
      if (lastValue != null && spec.series.length > 1 && right > 40) ends.push({ y: y(Math.min(lastValue, spec.yMax)), label: series.label });
    }
    ends.sort((a, b) => a.y - b.y);
    let lastY = -Infinity;
    for (const end of ends) {
      if (end.y - lastY < 13) continue; // would collide: the legend carries this series
      const text = el("text", { class: "direct-label", x: plotRight + 8, y: end.y + 4 }, svg);
      text.textContent = end.label;
      lastY = end.y;
    }

    if (spec.arrows) {
      const rowY = MARGIN.top + plotHeight + ARROW_ROW / 2 + 2;
      const stride = this.geometry.step < 14 ? 2 : 1;
      spec.arrows.forEach((a, i) => {
        if (a.deg == null || i % stride !== 0) return;
        // Points downwind: the direction the air is moving toward.
        el(
          "path",
          {
            d: "M0 -6 L4.5 4 L0 1.5 L-4.5 4 Z",
            fill: a.inWindow ? "var(--good)" : "var(--muted)",
            transform: `translate(${this.x(i).toFixed(1)} ${rowY}) rotate(${(a.deg + 180) % 360})`,
          },
          svg,
        );
      });
    }

    const crosshair = el("line", { class: "crosshair", x1: 0, x2: 0, y1: MARGIN.top, y2: MARGIN.top + plotHeight + arrowRow, visibility: "hidden" }, svg);
    this.crosshairs.push(crosshair);
  }

  private pointer(event: PointerEvent) {
    const svg = (event.target as Element).closest("svg");
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const scale = this.geometry.width / box.width;
    const x = (event.clientX - box.left) * scale;
    const index = Math.floor((x - this.geometry.left) / this.geometry.step);
    this.show(index >= 0 && index < this.hours.length ? index : null, event.clientX, event.clientY);
  }

  private show(index: number | null, clientX?: number, clientY?: number) {
    this.active = index;
    for (const line of this.crosshairs) {
      if (index == null) {
        line.setAttribute("visibility", "hidden");
      } else {
        line.setAttribute("x1", this.x(index).toFixed(1));
        line.setAttribute("x2", this.x(index).toFixed(1));
        line.setAttribute("visibility", "visible");
      }
    }
    if (index == null) {
      this.tooltip.hidden = true;
      return;
    }

    const h = this.hours[index];
    const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, this.launch.window);
    const tip = this.tooltip;
    tip.replaceChildren();
    html("div", { class: "tt-time" }, this.timeLabel(h.validAt, true), tip);
    const row = (label: string, value: string, color?: string, extra?: string) => {
      const r = html("div", { class: "tt-row" }, undefined, tip);
      const name = html("span", {}, undefined, r);
      if (color) html("span", { class: "key-line", style: `display:inline-block;width:12px;height:2px;background:${color}` }, undefined, name);
      name.appendChild(document.createTextNode(label));
      const strong = html("strong", {}, value, r);
      if (extra) html("span", { class: "status-in" }, ` ${extra}`, strong);
    };
    const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);
    row("Wind", `${dir(h.windDirectionDeg)}${fmt(mph(h.windSpeedMps))} mph`, "var(--series-1)", inWindow ? "✓" : undefined);
    row("Gust", `${fmt(mph(h.windGustMps))} mph`, "var(--series-2)");
    row("Transport", `${dir(h.transportWindDirectionDeg)}${fmt(mph(h.transportWindSpeedMps))} mph`, "var(--series-3)");
    row("Mixing height", `${fmt(ft(h.mixingHeightM), 0)} ft`);
    row("Sky cover", `${fmt(h.skyCoverPct)}%`);
    row("Precip / thunder", `${fmt(h.precipitationProbabilityPct)}% / ${fmt(h.thunderProbabilityPct)}%`);
    row("Temperature", `${fmt(fahrenheit(h.temperatureC))}°F`);
    if (h.shortForecast) html("div", { class: "tt-note" }, h.shortForecast, tip);
    tip.hidden = false;

    // Position near the pointer (or the crosshair when driven by keys), inside the chart.
    const rootBox = this.root.getBoundingClientRect();
    const tipWidth = tip.offsetWidth;
    const svgBox = this.crosshairs[0]?.ownerSVGElement?.getBoundingClientRect();
    const px = clientX ?? (svgBox ? svgBox.left + (this.x(index) / this.geometry.width) * svgBox.width : rootBox.left);
    const py = clientY ?? (svgBox ? svgBox.top + 40 : rootBox.top);
    let left = px - rootBox.left + 14;
    if (left + tipWidth > rootBox.width) left = px - rootBox.left - tipWidth - 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, py - rootBox.top - 20)}px`;
  }

  private renderTable(parent: HTMLElement) {
    const details = html("details", { class: "table-view" }, undefined, parent);
    details.style.marginTop = "16px";
    html("summary", {}, "Show as table", details);
    const scroll = html("div", { class: "chart-scroll" }, undefined, details);
    const table = html("table", { class: "data" }, undefined, scroll);
    const head = html("tr", {}, undefined, html("thead", {}, undefined, table));
    for (const title of ["Time", "Wind (mph)", "Gust", "Transport (mph)", "Mixing ht (ft)", "Sky", "Precip", "Thunder", "Temp", "Forecast"]) {
      html("th", { scope: "col" }, title, head);
    }
    const body = html("tbody", {}, undefined, table);
    const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);
    for (const h of this.hours) {
      const tr = html("tr", {}, undefined, body);
      const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, this.launch.window);
      html("td", {}, this.timeLabel(h.validAt, true), tr);
      html("td", {}, `${dir(h.windDirectionDeg)}${fmt(mph(h.windSpeedMps))}${inWindow ? " ✓" : ""}`, tr);
      html("td", {}, fmt(mph(h.windGustMps)), tr);
      html("td", {}, `${dir(h.transportWindDirectionDeg)}${fmt(mph(h.transportWindSpeedMps))}`, tr);
      html("td", {}, fmt(ft(h.mixingHeightM)), tr);
      html("td", {}, `${fmt(h.skyCoverPct)}%`, tr);
      html("td", {}, `${fmt(h.precipitationProbabilityPct)}%`, tr);
      html("td", {}, `${fmt(h.thunderProbabilityPct)}%`, tr);
      html("td", {}, `${fmt(fahrenheit(h.temperatureC))}°F`, tr);
      html("td", { class: "text" }, h.shortForecast ?? "", tr);
    }
    html("p", { class: "muted", style: "margin-top:8px;font-size:12px" }, `✓ = wind from the launch's window (${this.launch.windowLabel}).`, details);
  }
}
