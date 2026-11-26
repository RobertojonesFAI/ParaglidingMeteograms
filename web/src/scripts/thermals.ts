/**
 * The /thermals page: the Boise thermal forecast (/data/thermal_predictions.json,
 * see src/lib/thermals.ts) on a Leaflet map, with today and yesterday, an hour
 * stepper, the two models and their mean, a cell inspector and pilot reports.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  INPUT_LABELS,
  cellProbability,
  levelFor,
  monthName,
  parseThermalPayload,
  type DayKey,
  type Level,
  type ModelKey,
  type ThermalCell,
  type ThermalHour,
  type ThermalPayload,
} from "../lib/thermals.ts";

type BasemapKey = "satellite" | "topo";
type FilterKey = "all" | "high" | "med-high";
type UiStyleMode = "editorial" | "immersive";

interface MapLaunch {
  slug: string;
  name: string;
  lat: number;
  lon: number;
}

interface ReportSlot {
  countsByCell: Record<string, number>;
  userVerifiedCellId: number | null;
  loaded: boolean;
}

const BOISE_TZ = "America/Boise";
const DEFAULT_LOW = 0.35;
const DEFAULT_HIGH = 0.5;
// A forecast older than this is shown with a warning (the pipeline runs hourly).
const STALE_AFTER_MS = 3 * 3_600_000;

const HOTSPOTS: Record<string, { center: [number, number]; zoom: number }> = {
  bogus: { center: [43.764, -116.103], zoom: 12.5 },
  luckypeak: { center: [43.545, -116.035], zoom: 12.5 },
  foothills: { center: [43.675, -116.195], zoom: 12.5 },
  reset: { center: [43.645, -116.12], zoom: 11 },
};

const state = {
  data: null as ThermalPayload | null,
  launches: [] as MapLaunch[],
  activeDay: "today" as DayKey,
  activeModel: "ensemble" as ModelKey,
  activeHour: 5,
  activeBasemap: "satellite" as BasemapKey,
  activeFilter: "all" as FilterKey,
  lowThreshold: DEFAULT_LOW,
  highThreshold: DEFAULT_HIGH,
  selectedIndex: null as number | null,
  reports: {} as Record<string, ReportSlot>,
  map: null as L.Map | null,
  tileLayers: {} as Record<BasemapKey, L.TileLayer>,
  grid: null as L.LayerGroup | null,
  rects: [] as Array<{ index: number; rect: L.Rectangle; color: string }>,
};

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const setText = (id: string, text: string) => {
  const el = byId(id);
  if (el) el.textContent = text;
};

const COLORS: Record<Level, string> = { high: "#22c55e", medium: "#eab308", low: "#ef4444" };
const LEVEL_WORD: Record<Level, string> = { high: "High", medium: "Medium", low: "Low" };

function boiseNow(): { dateIso: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: BOISE_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { dateIso: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

// A random ID for this browser, so pilots sharing a mobile network can each report.
function deviceId(): string {
  let id = localStorage.getItem("thermals-device");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("thermals-device", id);
  }
  return id;
}

const activeDay = () => state.data?.days[state.activeDay] ?? null;
const activeHours = (): ThermalHour[] => activeDay()?.hours ?? [];
const activeHour = (): ThermalHour | null => activeHours()[state.activeHour] ?? null;

function slot(): { dateIso: string; hour: number; key: string; isPast: boolean } | null {
  const day = activeDay();
  const hour = activeHour();
  if (!day || !hour) return null;
  const now = boiseNow();
  const isPast = day.date_iso < now.dateIso || (day.date_iso === now.dateIso && hour.hour_local < now.hour);
  return { dateIso: day.date_iso, hour: hour.hour_local, key: `${day.date_iso}_${hour.hour_local}`, isPast };
}

function cardinal(angle: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round((((angle % 360) + 360) % 360) / 45) % 8];
}

// ---------------------------------------------------------------- notices

function showNotice() {
  const el = byId("thermal-notice");
  const data = state.data;
  if (!el) return;
  const lines: string[] = [];
  if (data) {
    const day = activeDay();
    const { first_month, last_month } = data.metadata.season;
    if (data.metadata.sample) lines.push("Sample data for development: not a forecast.");
    if (day && !day.supported) {
      lines.push(
        `No forecast for ${day.date_display}: the models were trained on data from ${monthName(first_month)} to ` +
          `${monthName(last_month)} and can't be trusted in other months. The map returns in ${monthName(first_month)}.`,
      );
    }
    const age = Date.now() - Date.parse(data.metadata.retrieved_at_utc);
    if (!data.metadata.sample && age > STALE_AFTER_MS) {
      lines.push(`This forecast was made ${data.metadata.retrieved_at_local} and has not been updated since.`);
    }
    const hour = activeHour();
    if (hour?.inputs_outside_training.length) {
      const names = [...new Set(hour.inputs_outside_training.map((n) => INPUT_LABELS[n] ?? n))].join(", ");
      lines.push(`At this hour some inputs are outside what the models saw in training (${names}): treat the map with extra caution.`);
    }
  } else {
    lines.push("The thermal forecast is not available right now.");
  }
  el.textContent = lines.join(" ");
  el.hidden = lines.length === 0;
}

// ---------------------------------------------------------------- map

function initMap() {
  const mapEl = byId("thermal-map");
  if (!mapEl) return;
  try {
    state.launches = JSON.parse(mapEl.dataset.launches ?? "[]") as MapLaunch[];
  } catch {
    state.launches = [];
  }

  const params = new URLSearchParams(window.location.search);
  const launch = state.launches.find((l) => l.slug === params.get("launch"));
  const start = launch ? { center: [launch.lat, launch.lon] as [number, number], zoom: 13 } : HOTSPOTS.reset;

  state.map = L.map(mapEl, { center: start.center, zoom: start.zoom });
  state.tileLayers.satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, attribution: "Tiles &copy; Esri" },
  );
  state.tileLayers.topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    subdomains: "abc",
    attribution: "Map data: &copy; OpenStreetMap, SRTM | Map style: &copy; OpenTopoMap",
  });
  state.tileLayers[state.activeBasemap].addTo(state.map);
  state.grid = L.layerGroup().addTo(state.map);

  // Launches sit in their own pane above the grid cells.
  state.map.createPane("launches").style.zIndex = "450";
  for (const l of state.launches) {
    L.circleMarker([l.lat, l.lon], { pane: "launches", radius: 7, color: "#ffffff", weight: 2, fillColor: "#1c5cab", fillOpacity: 1 })
      .bindTooltip(l.name, { direction: "top" })
      .on("click", () => {
        window.location.href = `/launches/${encodeURIComponent(l.slug)}`;
      })
      .addTo(state.map);
  }
}

function renderGrid() {
  const hour = activeHour();
  const data = state.data;
  if (!state.grid || !data) return;
  state.grid.clearLayers();
  state.rects = [];
  if (!hour) return;

  const half = data.metadata.grid_resolution_deg / 2;
  data.cells.forEach((cell, index) => {
    const p = cellProbability(hour, state.activeModel, index);
    if (p === null) return;
    const level = levelFor(p, state.lowThreshold, state.highThreshold);
    if (state.activeFilter === "high" && level !== "high") return;
    if (state.activeFilter === "med-high" && level === "low") return;

    const color = COLORS[level];
    const selected = state.selectedIndex === index;
    const rect = L.rectangle(
      [
        [cell.lat - half, cell.lon - half],
        [cell.lat + half, cell.lon + half],
      ],
      { fillColor: color, fillOpacity: selected ? 0.85 : 0.6, color: selected ? "#ffffff" : color, weight: selected ? 2.5 : 0.8 },
    );
    const tip = document.createElement("div");
    const strong = document.createElement("strong");
    strong.style.color = color;
    strong.textContent = `${Math.round(p * 100)}% · ${LEVEL_WORD[level]} chance`;
    tip.append(strong, document.createElement("br"), `${cell.zone} · ${cell.elevation} m (${Math.round(cell.elevation * 3.28084)} ft)`);
    rect.bindTooltip(tip, { sticky: true, opacity: 0.95 });
    rect.on("click", () => selectCell(index));
    rect.addTo(state.grid!);
    state.rects.push({ index, rect, color });
  });
}

function selectCell(index: number | null) {
  state.selectedIndex = index;
  for (const { index: i, rect, color } of state.rects) {
    const selected = i === index;
    rect.setStyle({ fillOpacity: selected ? 0.88 : 0.6, color: selected ? "#ffffff" : color, weight: selected ? 2.5 : 0.8 });
  }
  updateInspector();
}

// ---------------------------------------------------------------- hours and stats

function buildStepper() {
  const container = byId("hours-stepper");
  if (!container) return;
  container.replaceChildren();
  activeHours().forEach((hour, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `th-hour-btn${index === state.activeHour ? " active" : ""}`;
    btn.dataset.hour = String(index);
    const h = hour.hour_local;
    const tag = h === 12 ? "NOON" : h < 12 ? "MORNING" : h <= 17 ? "PEAK" : "EVENING";
    for (const [cls, text] of [
      ["th-hour-tag", tag],
      ["th-hour-time", hour.local_time_display],
      ["th-hour-icon", hour.is_daylight ? "☀️" : "🌇"],
    ]) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      btn.append(span);
    }
    btn.addEventListener("click", () => setHour(index));
    container.append(btn);
  });
}

function setHour(index: number) {
  const hours = activeHours();
  state.activeHour = Math.max(0, Math.min(index, hours.length - 1));
  document.querySelectorAll<HTMLButtonElement>(".th-hour-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.hour) === state.activeHour);
  });

  const day = activeDay();
  const hour = activeHour();
  setText("active-hour-display", hour ? `${state.activeDay === "today" ? "Today" : "Yesterday"} · ${hour.local_time_display}` : "No forecast");
  setText("active-date-display", day?.date_display ?? "—");
  const badge = byId("daylight-status-badge");
  if (badge) {
    badge.style.display = hour ? "" : "none";
    if (hour) {
      badge.className = hour.is_daylight ? "th-daylight-badge" : "th-daylight-badge night";
      badge.textContent = hour.is_daylight
        ? `☀️ Daylight (sun ${hour.sun_elevation_deg.toFixed(1)}°)`
        : `🌇 Sun down (${hour.sun_elevation_deg.toFixed(1)}°): no forecast`;
    }
  }

  const w = hour?.weather_summary;
  const f = w ? Math.round((w.temp_c * 9) / 5 + 32) : null;
  setText("weather-temp", w ? `${w.temp_c}°C (${f}°F)` : "--");
  setText("weather-wind", w ? `${w.wind_speed_mph} mph from ${cardinal(w.wind_dir_deg)}` : "--");
  setText("weather-blh", w ? `${Math.round(w.blh_m)} m` : "--");
  setText("weather-cape", w ? `${Math.round(w.cape_jkg)} J/kg` : "--");

  renderGrid();
  updateStats();
  showNotice();
  void loadReports();
  updateInspector();
}

function updateStats() {
  const hour = activeHour();
  const cells = state.data?.cells ?? [];
  const counts: Record<Level, number> = { high: 0, medium: 0, low: 0 };
  let sum = 0;
  let total = 0;
  if (hour) {
    cells.forEach((_, i) => {
      const p = cellProbability(hour, state.activeModel, i);
      if (p === null) return;
      counts[levelFor(p, state.lowThreshold, state.highThreshold)]++;
      sum += p;
      total++;
    });
  }
  const pct = (n: number) => (total ? `${((n / total) * 100).toFixed(1)}% (${n} cells)` : "--");
  setText("legend-model-name", state.activeModel === "ensemble" ? "Ensemble (mean)" : state.activeModel === "lightgbm" ? "LightGBM" : "XGBoost");
  setText("stat-high-pct", pct(counts.high));
  setText("stat-med-pct", pct(counts.medium));
  setText("stat-low-pct", pct(counts.low));
  setText("stat-mean-prob", total ? `${Math.round((sum / total) * 100)}%` : "--");
  setText("stat-total-cells", String(cells.length));
  document.querySelectorAll(".val-thresh-low").forEach((el) => (el.textContent = `${Math.round(state.lowThreshold * 100)}%`));
  document.querySelectorAll(".val-thresh-high").forEach((el) => (el.textContent = `${Math.round(state.highThreshold * 100)}%`));
}

// ---------------------------------------------------------------- inspector

function updateInspector() {
  const empty = byId("inspector-empty");
  const content = byId("inspector-content");
  const hour = activeHour();
  const index = state.selectedIndex;
  const cell: ThermalCell | undefined = index === null ? undefined : state.data?.cells[index];
  if (!empty || !content) return;
  if (!cell || !hour || index === null) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;

  setText("cell-zone-name", cell.zone);
  setText("cell-id-tag", `Cell #${cell.id} (${cell.lat.toFixed(3)}, ${cell.lon.toFixed(3)})`);
  setText("cell-elev", `${cell.elevation} m`);
  setText("cell-elev-ft", `${Math.round(cell.elevation * 3.28084).toLocaleString("en-US")} ft MSL`);
  setText("cell-slope", `${cell.slope.toFixed(1)}°`);
  setText("cell-slope-steepness", cell.slope > 20 ? "Steep" : cell.slope > 10 ? "Moderate" : "Gentle or flat");
  setText("cell-aspect", `${cell.aspect}°`);
  setText("cell-aspect-cardinal", `Faces ${cardinal(cell.aspect)}`);
  setText("cell-absorbed", `${hour.absorbed[index]}%`);

  for (const model of ["ensemble", "lightgbm", "xgboost"] as const) {
    const badge = byId(`badge-${model}`);
    const fill = byId(`fill-${model}`);
    if (!badge || !fill) continue;
    const p = cellProbability(hour, model, index);
    if (p === null) {
      badge.className = "th-score-badge";
      badge.textContent = "—";
      fill.style.width = "0%";
      continue;
    }
    const level = levelFor(p, state.lowThreshold, state.highThreshold);
    const suffix = level === "medium" ? "med" : level;
    badge.className = `th-score-badge th-badge-${suffix}`;
    badge.textContent = `${LEVEL_WORD[level]} (${Math.round(p * 100)}%)`;
    fill.className = `th-progress-fill th-fill-${suffix}`;
    fill.style.width = `${Math.round(p * 100)}%`;
  }

  const w = hour.weather_summary;
  setText("cell-hour-label", hour.local_time_display);
  setText("cell-temp", `${w.temp_c}°C (${Math.round((w.temp_c * 9) / 5 + 32)}°F)`);
  setText("cell-wind", `${w.wind_speed_mph} mph`);
  setText("cell-blh", `${Math.round(w.blh_m)} m`);
  const ens = cellProbability(hour, "ensemble", index);
  const trigger = byId("cell-trigger");
  if (trigger) {
    const level = ens === null ? null : levelFor(ens, state.lowThreshold, state.highThreshold);
    trigger.style.color = level ? `var(--th-${level === "medium" ? "med" : level})` : "";
    trigger.textContent = level === "high" ? "Likely" : level === "medium" ? "Possible" : level === "low" ? "Unlikely" : "—";
  }
  updateReportUI();
}

// ---------------------------------------------------------------- pilot reports

async function loadReports() {
  const s = slot();
  if (!s || state.reports[s.key]?.loaded) return;
  try {
    const res = await fetch(
      `/api/thermals/verifications?date=${encodeURIComponent(s.dateIso)}&hour=${s.hour}&device=${encodeURIComponent(deviceId())}`,
    );
    if (!res.ok) return;
    const body = (await res.json()) as { countsByCell?: Record<string, number>; userVerifiedCellId?: number | null };
    state.reports[s.key] = { countsByCell: body.countsByCell ?? {}, userVerifiedCellId: body.userVerifiedCellId ?? null, loaded: true };
    updateReportUI();
  } catch {
    // Offline: the button still works and the counts appear later.
  }
}

function updateReportUI() {
  const btn = byId<HTMLButtonElement>("btn-verify-thermal");
  const status = byId("cell-verify-status");
  const s = slot();
  const cell = state.selectedIndex === null ? undefined : state.data?.cells[state.selectedIndex];
  if (!btn || !status || !s || !cell) return;
  const reports = state.reports[s.key];
  const count = reports?.countsByCell[String(cell.id)] ?? 0;
  setText("cell-verify-count", count === 1 ? "1 report" : `${count} reports`);

  if (!s.isPast) {
    btn.disabled = true;
    status.textContent = "Reports open once this hour has passed.";
    return;
  }
  btn.disabled = false;
  const mine = reports?.userVerifiedCellId ?? null;
  if (mine === cell.id) {
    btn.disabled = true;
    status.textContent = "You reported a thermal in this cell for this hour.";
  } else if (mine !== null) {
    status.textContent = `You reported cell #${mine} for this hour. Reporting here moves your report.`;
  } else {
    status.textContent = `Found a thermal in cell #${cell.id} during this hour? One report per pilot per hour.`;
  }
}

async function submitReport() {
  const s = slot();
  const cell = state.selectedIndex === null ? undefined : state.data?.cells[state.selectedIndex];
  const btn = byId<HTMLButtonElement>("btn-verify-thermal");
  const status = byId("cell-verify-status");
  if (!s || !cell || !s.isPast) return;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/thermals/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dateIso: s.dateIso, hour: s.hour, cellId: cell.id, device: deviceId() }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      countsByCell?: Record<string, number>;
      userVerifiedCellId?: number | null;
    };
    if (res.ok) {
      state.reports[s.key] = { countsByCell: body.countsByCell ?? {}, userVerifiedCellId: body.userVerifiedCellId ?? cell.id, loaded: true };
      updateReportUI();
      return;
    }
    if (status) status.textContent = body.error ?? "Could not record the report.";
  } catch {
    if (status) status.textContent = "Network error: the report was not sent.";
  }
  if (btn) btn.disabled = false;
}

// ---------------------------------------------------------------- loading and controls

async function loadForecast() {
  setText("retrieval-time-display", "Loading…");
  try {
    const res = await fetch("/data/thermal_predictions.json");
    state.data = res.ok ? parseThermalPayload(await res.text()) : null;
  } catch {
    state.data = null;
  }
  const data = state.data;
  if (!data) {
    setText("retrieval-time-display", "Unavailable");
    showNotice();
    return;
  }
  state.lowThreshold = data.metadata.thresholds.low;
  state.highThreshold = data.metadata.thresholds.high;
  setText("retrieval-time-display", data.metadata.retrieved_at_local);
  setText("label-date-today", data.days.today.date_display);
  setText("label-date-yesterday", data.days.yesterday.date_display);

  // Start on the current hour when it is in the window, else on 1 PM.
  const now = boiseNow().hour;
  const hours = activeHours();
  const current = hours.findIndex((h) => h.hour_local === now);
  state.activeHour = current >= 0 ? current : Math.max(0, hours.findIndex((h) => h.hour_local === 13));
  buildStepper();
  setHour(state.activeHour);
}

function pressOnly(selector: string, pressed: HTMLElement) {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach((b) => b.setAttribute("aria-pressed", String(b === pressed)));
}

function applyUiStyle(mode: UiStyleMode, persist: boolean) {
  document.documentElement.dataset.thermalUi = mode;
  if (persist) localStorage.setItem("thermatics-ui-style", mode);
  document.querySelectorAll<HTMLButtonElement>("[data-ui-style]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.uiStyle === mode)));
  setTimeout(() => state.map?.invalidateSize(), 150);
}

function setupControls() {
  const query = new URLSearchParams(window.location.search).get("style");
  const saved = localStorage.getItem("thermatics-ui-style");
  applyUiStyle(query === "immersive" || query === "editorial" ? query : saved === "immersive" ? "immersive" : "editorial", false);

  document.querySelectorAll<HTMLButtonElement>("#thermal-day-tabs button[data-day]").forEach((btn) =>
    btn.addEventListener("click", () => {
      pressOnly("#thermal-day-tabs button[data-day]", btn);
      const hourBefore = activeHour()?.hour_local;
      state.activeDay = btn.dataset.day === "yesterday" ? "yesterday" : "today";
      const same = activeHours().findIndex((h) => h.hour_local === hourBefore);
      state.activeHour = same >= 0 ? same : 0;
      buildStepper();
      setHour(state.activeHour);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("#thermal-model-tabs button[data-model]").forEach((btn) =>
    btn.addEventListener("click", () => {
      pressOnly("#thermal-model-tabs button[data-model]", btn);
      state.activeModel = (btn.dataset.model as ModelKey) || "ensemble";
      renderGrid();
      updateStats();
      updateInspector();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-ui-style]").forEach((btn) =>
    btn.addEventListener("click", () => applyUiStyle(btn.dataset.uiStyle === "immersive" ? "immersive" : "editorial", true)),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-basemap]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const requested = btn.dataset.basemap as BasemapKey;
      if (!state.map || requested === state.activeBasemap) return;
      pressOnly("[data-basemap]", btn);
      state.map.removeLayer(state.tileLayers[state.activeBasemap]);
      state.activeBasemap = requested;
      state.tileLayers[requested].addTo(state.map);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) =>
    btn.addEventListener("click", () => {
      pressOnly("[data-filter]", btn);
      state.activeFilter = (btn.dataset.filter as FilterKey) || "all";
      renderGrid();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>(".quick-fly").forEach((btn) =>
    btn.addEventListener("click", () => {
      const launch = state.launches.find((l) => l.slug === btn.dataset.launch);
      const spot = launch ? { center: [launch.lat, launch.lon] as [number, number], zoom: 13 } : HOTSPOTS[btn.dataset.spot ?? ""];
      if (spot) state.map?.flyTo(spot.center, spot.zoom, { duration: 1.1 });
    }),
  );
  byId("btn-close-inspector")?.addEventListener("click", () => selectCell(null));
  byId("btn-verify-thermal")?.addEventListener("click", () => void submitReport());

  const modal = byId("threshold-modal");
  byId("btn-open-thresholds")?.addEventListener("click", () => modal && (modal.hidden = false));
  for (const id of ["btn-close-thresholds", "btn-apply-thresholds"]) byId(id)?.addEventListener("click", () => modal && (modal.hidden = true));

  const sliderLow = byId<HTMLInputElement>("slider-low-thresh");
  const sliderHigh = byId<HTMLInputElement>("slider-high-thresh");
  const refresh = () => {
    setText("display-low-thresh", `${Math.round(state.lowThreshold * 100)}%`);
    setText("display-high-thresh", `${Math.round(state.highThreshold * 100)}%`);
    renderGrid();
    updateStats();
    updateInspector();
  };
  sliderLow?.addEventListener("input", () => {
    const v = Number(sliderLow.value) / 100;
    if (v < state.highThreshold) state.lowThreshold = v;
    refresh();
  });
  sliderHigh?.addEventListener("input", () => {
    const v = Number(sliderHigh.value) / 100;
    if (v > state.lowThreshold) state.highThreshold = v;
    refresh();
  });
  byId("btn-reset-thresholds")?.addEventListener("click", () => {
    state.lowThreshold = state.data?.metadata.thresholds.low ?? DEFAULT_LOW;
    state.highThreshold = state.data?.metadata.thresholds.high ?? DEFAULT_HIGH;
    if (sliderLow) sliderLow.value = String(Math.round(state.lowThreshold * 100));
    if (sliderHigh) sliderHigh.value = String(Math.round(state.highThreshold * 100));
    refresh();
  });
}

if (byId("thermal-map")) {
  initMap();
  setupControls();
  void loadForecast();
}
