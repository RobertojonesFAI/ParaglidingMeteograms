// The sunlight curve under the sunlight map: W/m² through the day at one point,
// with the peak labelled and the map's current time marked. One series and one
// axis; hovering shows the value at each step, clicking moves the map there.

const SVG = "http://www.w3.org/2000/svg";
const MARGIN = { top: 26, right: 14, bottom: 26, left: 46 };
const HEIGHT = 190;

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.appendChild(node);
  return node;
}

export class SunCurve {
  private steps: number[] = [];
  private values: number[] = [];
  private current = 0;
  private label = "";
  private readonly tooltip: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private width = 0;
  private readonly time: Intl.DateTimeFormat;
  private readonly hour: Intl.DateTimeFormat;

  constructor(
    private readonly host: HTMLElement,
    timeZone: string,
    private readonly onPick: (index: number) => void,
  ) {
    this.time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
    this.hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone });
    host.style.position = "relative";
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";
    this.tooltip.hidden = true;
    this.observer = new ResizeObserver(() => {
      if (Math.abs(host.clientWidth - this.width) > 2) this.draw();
    });
    this.observer.observe(host);
  }

  /** Values (W/m²) at each step (ms), the current step, and what the series is ("Launch"). */
  set(steps: number[], values: number[], current: number, label: string) {
    this.steps = steps;
    this.values = values;
    this.current = current;
    this.label = label;
    this.draw();
  }

  setCurrent(index: number) {
    this.current = index;
    this.draw();
  }

  peakIndex() {
    let best = 0;
    for (let i = 1; i < this.values.length; i += 1) if (this.values[i] > this.values[best]) best = i;
    return best;
  }

  private draw() {
    const host = this.host;
    this.width = host.clientWidth || 600;
    host.replaceChildren();
    if (this.steps.length < 2) return;
    const W = this.width;
    const plotW = W - MARGIN.left - MARGIN.right;
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const t0 = this.steps[0];
    const t1 = this.steps[this.steps.length - 1];
    const peak = this.peakIndex();
    const top = Math.max(1000, Math.ceil(this.values[peak] / 250) * 250);
    const x = (ms: number) => MARGIN.left + ((ms - t0) / (t1 - t0)) * plotW;
    const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;

    const svg = el("svg", {
      viewBox: `0 0 ${W} ${HEIGHT}`,
      width: W,
      height: HEIGHT,
      role: "img",
      "aria-label": `${this.label}: sunlight through the day, peaking at ${Math.round(this.values[peak])} W/m² at ${this.time.format(this.steps[peak])}.`,
    });
    const grid = el("g", { class: "grid" }, svg);
    for (let v = 0; v <= top; v += 250) {
      el("line", { x1: MARGIN.left, x2: W - MARGIN.right, y1: y(v), y2: y(v), class: v === 0 ? "baseline" : "gridline" }, grid);
      const t = el("text", { x: MARGIN.left - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      t.textContent = v === 0 ? "0" : String(v);
    }
    const unit = el("text", { x: MARGIN.left - 6, y: MARGIN.top - 12, "text-anchor": "end", class: "tick" }, svg);
    unit.textContent = "W/m²";

    // Whole hours, thinned so labels never crowd.
    const hours: number[] = [];
    for (let t = Math.ceil(t0 / 3_600_000) * 3_600_000; t <= t1; t += 3_600_000) hours.push(t);
    const every = Math.max(1, Math.ceil(hours.length / Math.max(2, Math.floor(plotW / 64))));
    hours.forEach((t, i) => {
      if (i % every !== 0) return;
      const label = el("text", { x: x(t), y: HEIGHT - 8, "text-anchor": "middle", class: "tick" }, svg);
      label.textContent = this.hour.format(t);
    });

    const d = this.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(this.steps[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
    el("path", { d, class: "sun-line" }, svg);

    // Current time: a rule and a marker on the line.
    const cx = x(this.steps[this.current]);
    el("line", { x1: cx, x2: cx, y1: MARGIN.top, y2: MARGIN.top + plotH, class: "sun-now" }, svg);
    el("circle", { cx, cy: y(this.values[this.current]), r: 4.5, class: "sun-dot" }, svg);

    // The peak, labelled once.
    const px = x(this.steps[peak]);
    const py = y(this.values[peak]);
    el("circle", { cx: px, cy: py, r: 4, class: "sun-peak" }, svg);
    const peakLabel = el("text", { x: Math.min(Math.max(px, MARGIN.left + 60), W - MARGIN.right - 60), y: py - 9, "text-anchor": "middle", class: "direct-label" }, svg);
    peakLabel.textContent = `Peak ${this.time.format(this.steps[peak])} · ${Math.round(this.values[peak])}`;

    const crosshair = el("line", { y1: MARGIN.top, y2: MARGIN.top + plotH, class: "crosshair", visibility: "hidden" }, svg);
    const hit = el("rect", { x: MARGIN.left, y: 0, width: plotW, height: HEIGHT, fill: "transparent", style: "cursor:pointer" }, svg);
    const nearest = (event: PointerEvent) => {
      const box = svg.getBoundingClientRect();
      const ms = t0 + ((event.clientX - box.left - MARGIN.left) / plotW) * (t1 - t0);
      let best = 0;
      for (let i = 1; i < this.steps.length; i += 1) if (Math.abs(this.steps[i] - ms) < Math.abs(this.steps[best] - ms)) best = i;
      return best;
    };
    hit.addEventListener("pointermove", (event) => {
      const i = nearest(event);
      const hx = x(this.steps[i]);
      crosshair.setAttribute("x1", String(hx));
      crosshair.setAttribute("x2", String(hx));
      crosshair.setAttribute("visibility", "visible");
      this.tooltip.hidden = false;
      this.tooltip.innerHTML = "";
      const time = document.createElement("div");
      time.className = "tt-time";
      time.textContent = this.time.format(this.steps[i]);
      const row = document.createElement("div");
      row.className = "tt-row";
      const name = document.createElement("span");
      name.textContent = this.label;
      const value = document.createElement("strong");
      value.textContent = `${Math.round(this.values[i])} W/m²`;
      row.append(name, value);
      const note = document.createElement("div");
      note.className = "tt-note";
      note.textContent = "Click to show this time on the map";
      this.tooltip.append(time, row, note);
      const left = Math.min(Math.max(hx + 12, 0), W - 200);
      this.tooltip.style.left = `${hx > W - 220 ? hx - 212 : left}px`;
      this.tooltip.style.top = "4px";
    });
    hit.addEventListener("pointerleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      this.tooltip.hidden = true;
    });
    hit.addEventListener("click", (event) => this.onPick(nearest(event as PointerEvent)));
    host.append(svg, this.tooltip);
  }
}
