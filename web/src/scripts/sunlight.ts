// Sunlight on the terrain: a map of the sunlight (W/m²) reaching the ground
// around the launch, for the day picked in the page's day tabs, with a time
// slider and a curve for one point (the launch, or wherever the user taps).
// A 3D view (sunlight3d.ts, loaded on first use) drapes the same colours over
// the relief, so the slopes that face the sun stand out.
//
// The ground's slope, sky view and horizons come from pre-built terrain tiles
// (/data/solar/<slug>/); the sun's position and the sky are computed here for
// each 15-minute step, dimmed by the selected model's cloud cover.

import L from "leaflet";
import { localInstantMs } from "@azohra/meteo.briefing/derive";
import { clearSky, withClouds } from "../lib/irradiance.ts";
import { compassPoint, type Launch } from "../lib/launches.ts";
import { DATA_BASE } from "../lib/site.ts";
import { RAMP, fetchTile, pointIrradiance, pointParts, pointTerrain, rampLut, renderTile, type Frame, type PointTerrain, type SolarIndex, type SolarTile } from "../lib/solar-tile.ts";
import { fetchRelief, metresPerPixel } from "../lib/relief.ts";
import { SunCurve } from "../lib/sun-curve.ts";
import { sunPosition, sunriseSunset, sunVector } from "../lib/sun.ts";
import { baseMap, markerStyle } from "./map.ts";
import type { Sunlight3D } from "./sunlight3d.ts";

const STEP_MS = 15 * 60_000;
/** Top of the colour scale, W/m²; brighter slopes share the darkest colour. */
const SCALE_MAX = 1000;
const PLAY_MS = 450;
const TILE_CACHE = 96;
/** Relief exaggeration when "Exaggerate relief" is ticked. */
const EXAGGERATION = 2;

export interface CloudSeries {
  /** Model label, e.g. "HRRR 3 km". */
  label: string;
  points: { ms: number; fraction: number }[];
}

interface Selected {
  latlng: L.LatLng;
  terrain: PointTerrain;
  isLaunch: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function key(c: { x: number; y: number; z: number }) {
  return `${c.z}/${c.x}/${c.y}`;
}

type Attach = (canvas: HTMLCanvasElement, coords: L.Coords, done: L.DoneCallback) => void;

/** Map layer whose tiles are canvases the Sunlight controller paints. */
class SunlightLayer extends L.GridLayer {
  constructor(
    private readonly attach: Attach,
    options: L.GridLayerOptions,
  ) {
    super(options);
  }

  createTile(coords: L.Coords, done: L.DoneCallback) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    this.attach(canvas, coords, done);
    return canvas;
  }
}

export class Sunlight {
  private index: SolarIndex | null = null;
  private map: L.Map | null = null;
  private readonly lut = rampLut();
  private readonly image = new ImageData(256, 256);
  private readonly scratch = new Float32Array(66 * 66);
  private readonly loading = new Map<string, Promise<SolarTile | null>>();
  private readonly decoded = new Map<string, SolarTile>();
  private readonly visible = new Map<string, HTMLCanvasElement>();
  private started = false;
  private dateKey: string | null = null;
  private clouds: CloudSeries | null = null;
  private cloudsOn = true;
  private steps: number[] = [];
  private frames: Frame[] = [];
  private step = 0;
  private selected: Selected | null = null;
  private selectedMarker: L.CircleMarker | null = null;
  private values: number[] = [];
  private timer = 0;
  private raf = 0;
  private readonly curve: SunCurve;
  private readonly time: Intl.DateTimeFormat;
  private view: "2d" | "3d" = "2d";
  private three: Sunlight3D | null = null;
  private threeLoading: Promise<void> | null = null;
  /** The 3D view's draped picture and the tiles it is painted from. */
  private picture: HTMLCanvasElement | null = null;
  private pictureTiles: { tile: SolarTile; dx: number; dy: number }[] = [];
  private readonly tileCanvas = document.createElement("canvas");

  constructor(private readonly launch: Launch) {
    this.time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: launch.timeZone });
    this.curve = new SunCurve($("sun-curve"), launch.timeZone, (i) => this.setStep(i, true));
    this.renderLegend();

    $<HTMLInputElement>("sun-time").addEventListener("input", (e) => this.setStep(Number((e.target as HTMLInputElement).value), false));
    $("sun-play").addEventListener("click", () => this.togglePlay());
    $("sun-peak").addEventListener("click", () => this.setStep(this.curve.peakIndex(), true));
    $("sun-reset").addEventListener("click", () => void this.selectPoint(L.latLng(launch.latitude, launch.longitude), true));
    $<HTMLInputElement>("sun-clouds").addEventListener("change", (e) => {
      this.cloudsOn = (e.target as HTMLInputElement).checked;
      this.rebuildFrames(false);
    });
    for (const button of $("sun-view").querySelectorAll<HTMLButtonElement>("button")) {
      button.addEventListener("click", () => void this.setView(button.dataset.view === "3d" ? "3d" : "2d"));
    }
    $<HTMLInputElement>("sun-relief").addEventListener("change", (e) => this.three?.setExaggeration((e.target as HTMLInputElement).checked ? EXAGGERATION : 1));
    this.tileCanvas.width = this.tileCanvas.height = 256;

    // Nothing is downloaded until the section scrolls near the screen.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          void this.start();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe($("sun-section"));
  }

  /** Called by the launch page whenever the day or the model changes. */
  setDay(dateKey: string, clouds: CloudSeries | null) {
    const sameDay = dateKey === this.dateKey;
    const sameClouds = clouds?.label === this.clouds?.label && clouds?.points.length === this.clouds?.points.length;
    if (sameDay && sameClouds) return;
    this.dateKey = dateKey;
    this.clouds = clouds;
    if (this.index) this.rebuildFrames(!sameDay);
  }

  // ── setup ───────────────────────────────────────────────────────────────

  private async start() {
    if (this.started) return;
    this.started = true;
    const status = $("sun-status");
    status.textContent = "Loading the terrain…";
    try {
      const response = await fetch(`${DATA_BASE}/solar/${this.launch.slug}/index.json`);
      this.index = response.ok ? ((await response.json()) as SolarIndex) : null;
    } catch {
      this.index = null;
    }
    if (!this.index) {
      status.textContent = "The sunlight map for this launch is not published yet.";
      return;
    }
    status.hidden = true;
    $("sun-body").hidden = false;
    this.mountMap(this.index);
    const threeButton = $("sun-view").querySelector<HTMLButtonElement>('[data-view="3d"]')!;
    if (!this.index.relief) {
      threeButton.disabled = true;
      threeButton.title = "The 3D terrain for this launch is not published yet.";
    }
    const surface = this.index.sources.surface;
    const { area, radiusKm } = this.index.inputs;
    const covers = area ? `the ${area.name}` : `${radiusKm ?? 15} km around the launch`;
    $("sun-terrain").textContent = `The map covers ${covers}. Terrain: ${surface?.name ?? "elevation model"}, ${surface?.resolutionM ?? "?"} m`;
    const relief = this.index.relief;
    if (relief) $("sun-relief-spacing").textContent = `~${Math.round(metresPerPixel(this.launch.latitude, relief.zoom) / 5) * 5} m`;
    // The launch's own curve decides the starting time (now, or the day's peak).
    await this.selectPoint(L.latLng(this.launch.latitude, this.launch.longitude), true);
    if (this.dateKey) this.rebuildFrames(true);
  }

  private mountMap(index: SolarIndex) {
    const b = index.bounds;
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    // A launch with a whole range as its area can zoom out until the range fits a phone-wide map.
    const fitZoom = Math.floor(Math.log2((360 * 300) / (256 * (b.east - b.west))));
    const map = baseMap($("sun-map"), {
      minZoom: index.inputs.area ? Math.max(9, Math.min(index.tiles.minZoom, fitZoom)) : index.tiles.minZoom,
      maxZoom: 16,
      maxBounds: bounds.pad(0.2),
      maxBoundsViscosity: 0.8,
    });
    map.setView([this.launch.latitude, this.launch.longitude], 13);
    map.createPane("sunlight").style.zIndex = "250";

    const sources = [...new Set(Object.values(index.sources).map((s) => s.name))].join(" and ");
    const layer = new SunlightLayer((canvas, coords, done) => this.attachTile(canvas, coords, done), {
      pane: "sunlight",
      opacity: 0.8,
      bounds,
      minNativeZoom: index.tiles.minZoom,
      maxNativeZoom: index.tiles.maxZoom,
      updateWhenZooming: false,
      keepBuffer: 1,
      attribution: `Sunlight terrain: ${sources}`,
    });
    layer.on("tileunload", (event: L.TileEvent) => this.visible.delete(key(event.coords)));
    layer.addTo(map);

    L.circleMarker([this.launch.latitude, this.launch.longitude], markerStyle).bindTooltip(`${this.launch.name} launch`).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => void this.selectPoint(event.latlng, false));
    this.map = map;
  }

  // ── tiles ───────────────────────────────────────────────────────────────

  private inRange(coords: { x: number; y: number; z: number }) {
    const r = this.index?.tiles.ranges[String(coords.z)];
    return !!r && coords.x >= r[0] && coords.x <= r[2] && coords.y >= r[1] && coords.y <= r[3];
  }

  private loadTile(coords: { x: number; y: number; z: number }): Promise<SolarTile | null> {
    const index = this.index;
    if (!index || !this.inRange(coords)) return Promise.resolve(null);
    const k = key(coords);
    let pending = this.loading.get(k);
    if (!pending) {
      const path = index.tiles.path.replace("{z}", String(coords.z)).replace("{x}", String(coords.x)).replace("{y}", String(coords.y));
      pending = fetchTile(`${DATA_BASE}/solar/${this.launch.slug}/${path}`, index)
        .then((tile) => {
          if (tile) this.decoded.set(k, tile);
          this.trimCache();
          return tile;
        })
        .catch(() => {
          this.loading.delete(k);
          return null;
        });
      this.loading.set(k, pending);
    }
    return pending;
  }

  /** Forgets the oldest decoded tiles that are off screen. */
  private trimCache() {
    for (const k of this.decoded.keys()) {
      if (this.decoded.size <= TILE_CACHE) break;
      if (this.visible.has(k)) continue;
      this.decoded.delete(k);
      this.loading.delete(k);
    }
  }

  private attachTile(canvas: HTMLCanvasElement, coords: L.Coords, done: L.DoneCallback) {
    this.visible.set(key(coords), canvas);
    void this.loadTile(coords).then((tile) => {
      if (tile && this.frames.length > 0) this.draw(canvas, tile);
      done(undefined, canvas);
    });
  }

  private draw(canvas: HTMLCanvasElement, tile: SolarTile) {
    const frame = this.frames[this.step];
    if (!frame) return;
    renderTile(tile, frame, this.image.data, this.lut, SCALE_MAX, this.scratch);
    canvas.getContext("2d")?.putImageData(this.image, 0, 0);
  }

  private redraw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      if (this.view === "3d") {
        this.drawPicture();
        return;
      }
      for (const [k, canvas] of this.visible) {
        const tile = this.decoded.get(k);
        if (tile) this.draw(canvas, tile);
      }
    });
  }

  // ── 3D view ─────────────────────────────────────────────────────────────

  private async setView(view: "2d" | "3d") {
    if (view === this.view) return;
    const buttons = $("sun-view").querySelectorAll<HTMLButtonElement>("button");
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.view === view));
    this.view = view;
    $("sun-map").hidden = view === "3d";
    $("sun-3d").hidden = view === "2d";
    $("sun-relief-label").hidden = view === "2d";
    if (view === "2d") {
      this.map?.invalidateSize();
      this.redraw();
      return;
    }
    this.threeLoading ??= this.open3D();
    await this.threeLoading;
    this.redraw();
  }

  private async open3D() {
    const index = this.index;
    const status = $("sun-3d-status");
    if (!index?.relief) return;
    status.hidden = false;
    status.textContent = "Loading the 3D terrain…";
    try {
      const module = await import("./sunlight3d.ts");
      if (!module.webglAvailable()) {
        status.textContent = "This browser cannot draw 3D (WebGL is off or not supported). The 2D map shows the same sunlight.";
        return;
      }
      const meta = index.relief;
      const [heights] = await Promise.all([fetchRelief(`${DATA_BASE}/solar/${this.launch.slug}/${meta.path}`, meta), this.loadPictureTiles()]);
      if (!heights || !this.picture) throw new Error("terrain missing");
      this.three = new module.Sunlight3D({
        container: $("sun-3d"),
        meta,
        heights,
        picture: this.picture,
        launch: this.launch,
        onPick: (lat, lon) => void this.selectPoint(L.latLng(lat, lon), false),
      });
      this.three.setExaggeration($<HTMLInputElement>("sun-relief").checked ? EXAGGERATION : 1);
      if (this.selected && !this.selected.isLaunch) this.three.setSelected({ lat: this.selected.latlng.lat, lon: this.selected.latlng.lng });
      status.hidden = true;
    } catch {
      status.textContent = "The 3D terrain could not be loaded. The 2D map shows the same sunlight.";
      this.threeLoading = null;
    }
  }

  /**
   * The draped picture is painted from the tiles one zoom finer than the
   * relief grid, covering exactly the relief's extent.
   */
  private async loadPictureTiles() {
    const index = this.index;
    const meta = index?.relief;
    if (!index || !meta) return;
    const z = Math.min(index.tiles.maxZoom, Math.max(index.tiles.minZoom, meta.zoom + 1));
    const s = 2 ** (z - meta.zoom);
    const range = index.tiles.ranges[String(z)];
    const canvas = document.createElement("canvas");
    canvas.width = (meta.width - 1) * s;
    canvas.height = (meta.height - 1) * s;
    const jobs: Promise<void>[] = [];
    const tiles: { tile: SolarTile; dx: number; dy: number }[] = [];
    for (let y = range[1]; y <= range[3]; y += 1) {
      for (let x = range[0]; x <= range[2]; x += 1) {
        jobs.push(
          this.loadTile({ z, x, y }).then((tile) => {
            if (tile) tiles.push({ tile, dx: x * 256 - meta.x0 * s, dy: y * 256 - meta.y0 * s });
          }),
        );
      }
    }
    await Promise.all(jobs);
    this.pictureTiles = tiles;
    this.picture = canvas;
    this.drawPicture();
  }

  private drawPicture() {
    const picture = this.picture;
    const frame = this.frames[this.step];
    if (!picture || !frame) return;
    const ctx = picture.getContext("2d")!;
    const tileCtx = this.tileCanvas.getContext("2d")!;
    ctx.fillStyle = getComputedStyle($("sun-3d")).getPropertyValue("--surface-2").trim() || "#f0efec";
    ctx.fillRect(0, 0, picture.width, picture.height);
    for (const { tile, dx, dy } of this.pictureTiles) {
      renderTile(tile, frame, this.image.data, this.lut, SCALE_MAX, this.scratch);
      tileCtx.putImageData(this.image, 0, 0);
      ctx.drawImage(this.tileCanvas, dx, dy);
    }
    this.three?.setSun(frame.azimuthDeg, frame.elevationDeg);
    this.three?.pictureChanged();
    $("sun-3d-sun").textContent =
      frame.elevationDeg > 0 ? `${this.time.format(this.steps[this.step])} · sun ${Math.round(frame.elevationDeg)}° high in the ${compassPoint(frame.azimuthDeg)}` : `${this.time.format(this.steps[this.step])} · sun below the horizon`;
  }

  // ── time ────────────────────────────────────────────────────────────────

  private cloudAt(ms: number): number | null {
    const points = this.clouds?.points;
    if (!points || points.length === 0) return null;
    if (ms < points[0].ms - 3 * 3_600_000 || ms > points[points.length - 1].ms + 3 * 3_600_000) return null;
    if (ms <= points[0].ms) return points[0].fraction;
    for (let i = 1; i < points.length; i += 1) {
      if (ms <= points[i].ms) {
        const a = points[i - 1];
        const b = points[i];
        return a.fraction + ((b.fraction - a.fraction) * (ms - a.ms)) / (b.ms - a.ms);
      }
    }
    return points[points.length - 1].fraction;
  }

  private frameAt(ms: number): Frame {
    const sun = sunPosition(ms, this.launch.latitude, this.launch.longitude);
    let sky = clearSky(sun, this.index?.referenceElevationM ?? 1000);
    const cloud = this.cloudsOn ? this.cloudAt(ms) : null;
    if (cloud !== null) sky = withClouds(sky, sun.elevationDeg, cloud);
    return { elevationDeg: sun.elevationDeg, azimuthDeg: sun.azimuthDeg, sun: sunVector(sun), sky };
  }

  /** Recomputes the day's steps and skies; `newDay` also picks a starting time. */
  private rebuildFrames(newDay: boolean) {
    if (!this.dateKey) return;
    const midnight = localInstantMs(this.dateKey, 0, this.launch.timeZone);
    const daylight = sunriseSunset(midnight, midnight + 86_400_000, this.launch.latitude, this.launch.longitude);
    const slider = $<HTMLInputElement>("sun-time");
    if (!daylight) {
      this.steps = [];
      this.frames = [];
      $("sun-readout").textContent = "The sun does not rise on this day.";
      return;
    }
    const first = Math.ceil(daylight.sunrise / STEP_MS) * STEP_MS;
    const last = Math.floor(daylight.sunset / STEP_MS) * STEP_MS;
    const previous = this.steps[this.step];
    this.steps = [];
    for (let t = first; t <= last; t += STEP_MS) this.steps.push(t);
    this.frames = this.steps.map((t) => this.frameAt(t));
    slider.min = "0";
    slider.max = String(this.steps.length - 1);
    $("sun-daylight").textContent = `Sunrise ${this.time.format(daylight.sunrise)} · sunset ${this.time.format(daylight.sunset)}`;

    const covered = this.clouds !== null && this.steps.some((t) => this.cloudAt(t) !== null);
    $("sun-cloud-note").textContent = !this.cloudsOn
      ? "Clear sky"
      : covered
        ? `Clouds from ${this.clouds?.label}`
        : "Clear sky: no model forecast covers this day";

    this.computeValues();
    if (newDay || previous === undefined) {
      const now = Date.now();
      this.step = now >= first && now <= last ? Math.round((now - first) / STEP_MS) : this.values.length ? this.curve.peakIndex() : 0;
    } else {
      this.step = Math.max(0, Math.min(this.steps.length - 1, Math.round((previous - first) / STEP_MS)));
    }
    this.setStep(this.step, true);
  }

  private computeValues() {
    const terrain = this.selected?.terrain;
    this.values = terrain ? this.frames.map((f) => pointIrradiance(terrain, f)) : [];
    const label = this.selected ? (this.selected.isLaunch ? "Launch" : "Selected point") : "";
    if (terrain && this.steps.length) this.curve.set(this.steps, this.values, Math.min(this.step, this.steps.length - 1), label);
    const peak = this.values.length ? this.curve.peakIndex() : -1;
    const button = $<HTMLButtonElement>("sun-peak");
    button.textContent = peak >= 0 ? `Peak ${this.time.format(this.steps[peak])}` : "Peak";
    button.disabled = peak < 0;
    this.renderTable();
  }

  private setStep(index: number, moveSlider: boolean) {
    if (this.steps.length === 0) return;
    this.step = Math.max(0, Math.min(this.steps.length - 1, index));
    const slider = $<HTMLInputElement>("sun-time");
    if (moveSlider) slider.value = String(this.step);
    const label = this.time.format(this.steps[this.step]);
    $("sun-time-label").textContent = label;
    slider.setAttribute("aria-valuetext", label);
    if (this.values.length) this.curve.setCurrent(this.step);
    this.updateReadout();
    this.redraw();
  }

  private togglePlay() {
    const button = $("sun-play");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
      button.textContent = "Play";
      button.setAttribute("aria-pressed", "false");
      return;
    }
    if (this.step >= this.steps.length - 1) this.setStep(0, true);
    button.textContent = "Pause";
    button.setAttribute("aria-pressed", "true");
    this.timer = window.setInterval(() => {
      if (this.step >= this.steps.length - 1) {
        this.togglePlay();
        return;
      }
      this.setStep(this.step + 1, true);
    }, PLAY_MS);
  }

  // ── point ───────────────────────────────────────────────────────────────

  private async selectPoint(latlng: L.LatLng, isLaunch: boolean) {
    const map = this.map;
    const index = this.index;
    if (!map || !index) return;
    const p = map.project(latlng, index.tiles.maxZoom);
    const X = Math.floor(p.x);
    const Y = Math.floor(p.y);
    const tile = await this.loadTile({ z: index.tiles.maxZoom, x: X >> 8, y: Y >> 8 });
    const terrain = tile ? pointTerrain(tile, X & 255, Y & 255) : null;
    if (!terrain) {
      $("sun-readout").textContent = "No terrain data at that spot: pick a point inside the coloured area.";
      return;
    }
    this.selected = { latlng, terrain, isLaunch };
    this.selectedMarker?.remove();
    this.selectedMarker = isLaunch
      ? null
      : L.circleMarker(latlng, { radius: 7, color: "#ffffff", weight: 2, fillColor: "#0b0b0b", fillOpacity: 1 }).addTo(map);
    $("sun-reset").hidden = isLaunch;
    this.three?.setSelected(isLaunch ? null : { lat: latlng.lat, lon: latlng.lng });
    const slope = (Math.acos(Math.min(1, terrain.nz / Math.hypot(terrain.nx, terrain.ny, terrain.nz))) * 180) / Math.PI;
    const aspect = ((Math.atan2(terrain.nx, terrain.ny) * 180) / Math.PI + 360) % 360;
    const where = isLaunch ? `${this.launch.name} launch` : `Point ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
    $("sun-point").textContent = `${where} · ${slope < 3 ? "flat ground" : `${Math.round(slope)}° slope facing ${compassPoint(aspect)}`}`;
    this.computeValues();
    this.updateReadout();
  }

  private updateReadout() {
    const frame = this.frames[this.step];
    if (!frame || !this.selected) return;
    const value = this.values[this.step] ?? 0;
    const sun = frame.elevationDeg > 0 ? `sun ${Math.round(frame.elevationDeg)}° high in the ${compassPoint(frame.azimuthDeg)}` : "sun below the horizon";
    const parts = pointParts(this.selected.terrain, frame);
    const shade = parts.ridgeShadow ? " · in a ridge's shadow" : parts.facingAway ? " · slope faces away from the sun" : "";
    const cloud = this.cloudsOn ? this.cloudAt(this.steps[this.step]) : null;
    $("sun-readout").textContent = `${this.time.format(this.steps[this.step])}: ${Math.round(value)} W/m² · ${sun}${shade}${
      cloud !== null ? ` · ${Math.round(cloud * 100)} % cloud` : ""
    }`;
  }

  private renderTable() {
    const body = $("sun-table");
    body.replaceChildren();
    for (let i = 0; i < this.steps.length; i += 2) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = this.time.format(this.steps[i]);
      const td = document.createElement("td");
      td.textContent = String(Math.round(this.values[i] ?? 0));
      tr.append(th, td);
      body.appendChild(tr);
    }
  }

  private renderLegend() {
    $("sun-legend-bar").style.background = `linear-gradient(to right, ${RAMP.join(", ")})`;
    $("sun-legend-ticks").replaceChildren(
      ...[0, 250, 500, 750, 1000].map((v) => {
        const span = document.createElement("span");
        span.textContent = v === 1000 ? "1000+" : String(v);
        return span;
      }),
    );
  }
}
