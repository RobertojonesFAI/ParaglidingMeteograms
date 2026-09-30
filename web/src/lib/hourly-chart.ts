// Hourly forecast charts as small-multiple panels sharing one hour axis. Each
// panel has one y-axis; a crosshair and tooltip track the pointer (or the
// arrow keys) across all panels, and a table view carries every value. What
// the panels, tooltip and table show comes from a ChartSpec (see nws-chart.ts
// and ecmwf-chart.ts).

import { fmt } from "./units.ts";

const SVG = "http://www.w3.org/2000/svg";

export function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.appendChild(node);
  return node;
}

export function html<K extends keyof HTMLElementTagNameMap>(name: K, attrs: Record<string, string> = {}, text?: string, parent?: Element) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

export function niceMax(value: number, step: number) {
  return Math.max(step, Math.ceil(value / step) * step);
}

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  area?: boolean;
}

export interface PanelSpec {
  title: string;
  unit: string;
  height: number;
  /** Bottom of the axis; 0 unless the quantity has no natural zero (temperature). */
  yMin?: number;
  yMax: number;
  yStep: number;
  series: Series[];
  legend?: { label: string; kind: "line" | "band" | "limit" | "arrow-in" | "arrow-out"; color: string }[];
  band?: { from: number; to: number };
  limit?: number;
  arrows?: { deg: number | null; inWindow: boolean }[];
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
  extra?: string;
}

export interface ChartSpec<T extends { validAt: string }> {
  /** Shown when the day has no hours. */
  emptyText: string;
  /** Spacing of the points; 60 (hourly) unless the data is finer, e.g. 5 for station reports. */
  minutesPerPoint?: number;
  /** Accessible name of the chart group. */
  label?: string;
  panels(hours: T[]): PanelSpec[];
  tooltip(hour: T): TooltipRow[];
  note?(hour: T): string | null;
  table: { columns: string[]; cells(hour: T): string[]; footnote?: string; textColumns?: number[] };
}

const MARGIN = { top: 10, bottom: 24, left: 44 };
const ARROW_ROW = 28;

export class HourlyChart<T extends { validAt: string }> {
  private hours: T[] = [];
  private active: number | null = null;
  private crosshairs: SVGLineElement[] = [];
  private tooltip!: HTMLDivElement;
  private geometry = { left: MARGIN.left, step: 1, width: 0 };
  private readonly observer: ResizeObserver;

  constructor(
    private readonly root: HTMLElement,
    private readonly spec: ChartSpec<T>,
    private readonly timeZone: string,
  ) {
    this.observer = new ResizeObserver(() => {
      if (this.hours.length > 0 && Math.abs(this.root.clientWidth - this.geometry.width) > 4) this.render();
    });
    this.observer.observe(root);
  }

  setHours(hours: T[]) {
    this.hours = hours;
    this.active = null;
    this.render();
  }

  private get minutesPerPoint() {
    return this.spec.minutesPerPoint ?? 60;
  }

  timeLabel(iso: string, withDay = false, withMinutes = false) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: this.timeZone,
      hour: "numeric",
      ...(withMinutes ? { minute: "2-digit" } : {}),
      ...(withDay ? { weekday: "short" } : {}),
    }).format(new Date(iso));
  }

  /** Tooltip and table time: minutes too when points are closer than an hour. */
  private pointLabel(iso: string) {
    return this.timeLabel(iso, true, this.minutesPerPoint < 60);
  }

  private render() {
    const { root, hours } = this;
    root.replaceChildren();
    this.crosshairs = [];
    if (hours.length === 0) {
      html("p", { class: "chart-status" }, this.spec.emptyText, root);
      return;
    }

    const width = Math.max(320, root.clientWidth);
    const right = width < 560 ? 12 : 84;
    const plotWidth = width - MARGIN.left - right;
    this.geometry = { left: MARGIN.left, step: plotWidth / hours.length, width };

    const group = html("div", {
      class: "nws-panels",
      tabindex: "0",
      role: "group",
      "aria-label": this.spec.label ?? "Hourly forecast charts. Use the left and right arrow keys to step through hours.",
    });
    root.appendChild(group);
    for (const panel of this.spec.panels(hours)) this.renderPanel(group, panel, width, right);

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
    const index = this.hours.findIndex((h) => Date.parse(h.validAt) + this.minutesPerPoint * 60_000 > now);
    return index < 0 ? this.hours.length - 1 : index;
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
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${spec.title} ${this.minutesPerPoint < 60 ? "over time" : "by hour"}` }, wrap);

    const yMin = spec.yMin ?? 0;
    const clamp = (v: number) => Math.min(Math.max(v, yMin), spec.yMax);
    const y = (v: number) => MARGIN.top + plotHeight - ((clamp(v) - yMin) / (spec.yMax - yMin)) * plotHeight;
    const left = MARGIN.left;
    const plotRight = width - right;

    if (spec.band) {
      const top = y(spec.band.to);
      el("rect", { x: left, y: top, width: plotRight - left, height: y(spec.band.from) - top, fill: "var(--good-wash)" }, svg);
    }

    for (let v = yMin; v <= spec.yMax; v += spec.yStep) {
      el("line", { class: v === yMin ? "baseline" : "grid", x1: left, x2: plotRight, y1: y(v), y2: y(v) }, svg);
      const label = el("text", { class: "tick", x: left - 6, y: y(v) + 4, "text-anchor": "end" }, svg);
      label.textContent = fmt(v);
    }

    if (spec.limit !== undefined && spec.limit <= spec.yMax) {
      el("line", { x1: left, x2: plotRight, y1: y(spec.limit), y2: y(spec.limit), stroke: "var(--critical)", "stroke-width": 1.5, "stroke-dasharray": "4 3" }, svg);
    }

    // x ticks every 3 hours (every 6 when narrow), at the first point of the hour
    const pointsPerHour = 60 / this.minutesPerPoint;
    const every = this.geometry.step * pointsPerHour < 18 ? 6 : 3;
    const hourOf = new Intl.DateTimeFormat("en-US", { timeZone: this.timeZone, hour: "numeric", hourCycle: "h23" });
    let previousHour: number | null = null;
    this.hours.forEach((h, i) => {
      const hour = Number(hourOf.format(new Date(h.validAt)));
      const first = hour !== previousHour;
      previousHour = hour;
      if (!first || hour % every !== 0) return;
      const label = el("text", { class: "tick", x: this.x(i), y: height - 6, "text-anchor": "middle" }, svg);
      label.textContent = this.timeLabel(h.validAt);
    });

    // series: area wash first, then lines; direct end labels when they do not collide
    const ends: { y: number; label: string }[] = [];
    for (const series of spec.series) {
      // Runs of consecutive values; a null breaks the line (and its area) into pieces.
      const runs: number[][] = [];
      let run: number[] = [];
      series.values.forEach((v, i) => {
        if (v == null) {
          if (run.length) runs.push(run);
          run = [];
        } else run.push(i);
      });
      if (run.length) runs.push(run);
      const pathOf = (indices: number[]) => indices.map((i, k) => `${k ? "L" : "M"}${this.x(i).toFixed(1)} ${y(series.values[i]!).toFixed(1)}`).join(" ");
      const d = runs.map(pathOf).join(" ");
      if (!d) continue;
      if (series.area) {
        const area = runs
          .map((r) => `${pathOf(r)} L${this.x(r[r.length - 1]).toFixed(1)} ${y(yMin).toFixed(1)} L${this.x(r[0]).toFixed(1)} ${y(yMin).toFixed(1)} Z`)
          .join(" ");
        el("path", { d: area, fill: series.color, "fill-opacity": 0.1 }, svg);
      }
      el("path", { d, fill: "none", stroke: series.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const lastIndex = series.values.length - 1 - [...series.values].reverse().findIndex((v) => v != null);
      const lastValue = series.values[lastIndex];
      if (lastValue != null && spec.series.length > 1 && right > 40) ends.push({ y: y(lastValue), label: series.label });
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
      const stride = Math.max(1, Math.ceil(14 / this.geometry.step));
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
    const tip = this.tooltip;
    tip.replaceChildren();
    html("div", { class: "tt-time" }, this.pointLabel(h.validAt), tip);
    for (const row of this.spec.tooltip(h)) {
      const r = html("div", { class: "tt-row" }, undefined, tip);
      const name = html("span", {}, undefined, r);
      if (row.color) html("span", { class: "key-line", style: `display:inline-block;width:12px;height:2px;background:${row.color}` }, undefined, name);
      name.appendChild(document.createTextNode(row.label));
      const strong = html("strong", {}, row.value, r);
      if (row.extra) html("span", { class: "status-in" }, ` ${row.extra}`, strong);
    }
    const note = this.spec.note?.(h);
    if (note) html("div", { class: "tt-note" }, note, tip);
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
    const { table: spec } = this.spec;
    const details = html("details", { class: "table-view" }, undefined, parent);
    details.style.marginTop = "16px";
    html("summary", {}, "Show as table", details);
    const scroll = html("div", { class: "chart-scroll" }, undefined, details);
    const table = html("table", { class: "data" }, undefined, scroll);
    const head = html("tr", {}, undefined, html("thead", {}, undefined, table));
    for (const title of ["Time", ...spec.columns]) html("th", { scope: "col" }, title, head);
    const body = html("tbody", {}, undefined, table);
    for (const h of this.hours) {
      const tr = html("tr", {}, undefined, body);
      html("td", {}, this.pointLabel(h.validAt), tr);
      spec.cells(h).forEach((cell, i) => html("td", spec.textColumns?.includes(i) ? { class: "text" } : {}, cell, tr));
    }
    if (spec.footnote) html("p", { class: "muted", style: "margin-top:8px;font-size:12px" }, spec.footnote, details);
  }
}
