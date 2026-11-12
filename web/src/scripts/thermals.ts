/**
 * Unified Thermal Prediction Engine (Boise Domain) for ParaglidingMeteograms.
 * Visualizes daytime (8:00 AM – 8:00 PM) thermal probability forecasts for Today & Yesterday
 * across 690 terrain grid cells with hourly selection, multi-model comparison
 * (Ensemble, LightGBM, XGBoost), cell intelligence inspection, and switchable UI modes.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type DayKey = "today" | "yesterday";
export type ModelKey = "ensemble" | "lightgbm" | "xgboost";
export type BasemapKey = "satellite" | "topo";
export type FilterKey = "all" | "high" | "med-high";
export type UiStyleMode = "editorial" | "immersive";

export interface ModelPrediction {
  probability: number;
  percentage?: number;
  level?: string;
  label?: string;
  color?: string;
}

export interface ThermalCell {
  id: number;
  lat: number;
  lon: number;
  elevation: number;
  mean_slope: number;
  mean_aspect: number;
  zone: string;
  absorbed_radiation: number;
  predictions: Record<ModelKey, ModelPrediction>;
}

export interface ModelStats {
  mean_probability: number;
  high_count: number;
  high_pct: number;
  med_count: number;
  med_pct: number;
  low_count: number;
  low_pct: number;
}

export interface WeatherSummary {
  temp_c: number;
  temp_f: number;
  dew_c: number;
  wind_speed_mph: number;
  wind_dir_deg: number;
  cape_jkg: number;
  blh_m: number;
  sensible_heat_wm2?: number;
  net_radiation_wm2?: number;
}

export interface ForecastHour {
  forecast_hour: number;
  hour_local?: number;
  valid_time_iso: string;
  local_time_display: string;
  local_date_display: string;
  is_daylight: boolean;
  sun_elevation_deg: number;
  weather_summary: WeatherSummary;
  stats: Record<ModelKey, ModelStats>;
  cells: ThermalCell[];
}

export interface ForecastDayBlock {
  key: DayKey;
  label: string;
  date_display: string;
  forecast_hours: ForecastHour[];
}

export interface ForecastPayload {
  metadata: {
    retrieved_at_local?: string;
    today_date_iso?: string;
    today_date_display?: string;
    yesterday_date_iso?: string;
    yesterday_date_display?: string;
    total_cells?: number;
    thresholds?: { low?: number; high?: number };
  };
  forecast_days?: Record<DayKey, ForecastDayBlock>;
  forecast_hours: ForecastHour[];
}

interface VerificationSlotState {
  countsByCell: Record<string, number>;
  userVerified: boolean;
  userVerifiedCellId: number | null;
  loaded: boolean;
  loading: boolean;
}

const BOISE_TZ = "America/Boise";

const BoiseHotspots: Record<string, { center: [number, number]; zoom: number; name: string }> = {
  cervidae: { center: [43.6003, -115.9369], zoom: 13, name: "Cervidae Peak" },
  bogus: { center: [43.764, -116.103], zoom: 12.5, name: "Bogus Basin / Shafer Butte" },
  luckypeak: { center: [43.545, -116.035], zoom: 12.5, name: "Lucky Peak / Mores Creek" },
  foothills: { center: [43.675, -116.195], zoom: 12.5, name: "Boise Foothills" },
  reset: { center: [43.65, -116.12], zoom: 11, name: "Boise Regional Overview" },
};

const state = {
  forecastData: null as ForecastPayload | null,
  activeDay: "today" as DayKey,
  activeModel: "ensemble" as ModelKey,
  activeHour: 5, // Defaults to 1:00 PM (index 5 of 8 AM..8 PM) or current daytime hour
  activeBasemap: "satellite" as BasemapKey,
  activeFilter: "all" as FilterKey,
  uiStyle: "editorial" as UiStyleMode,
  lowThreshold: 0.35,
  highThreshold: 0.50,
  selectedCellId: null as number | null,
  verificationsBySlot: {} as Record<string, VerificationSlotState>,
  map: null as L.Map | null,
  tileLayers: {} as Record<BasemapKey, L.TileLayer>,
  gridLayerGroup: null as L.LayerGroup | null,
  cellRectangles: [] as Array<{ id: number; rect: L.Rectangle; cell: ThermalCell }>,
};

function formatBoiseIsoAndHour(ms: number): { dateIso: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOISE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const rawHour = Number(get("hour"));
  return {
    dateIso: `${get("year")}-${get("month")}-${get("day")}`,
    hour: rawHour === 24 ? 0 : rawHour,
  };
}

function getBoiseClockNow(): { todayIso: string; yesterdayIso: string; currentHour: number } {
  const nowMs = Date.now();
  const today = formatBoiseIsoAndHour(nowMs);
  const yesterday = formatBoiseIsoAndHour(nowMs - 86_400_000);
  return {
    todayIso: today.dateIso,
    yesterdayIso: yesterday.dateIso,
    currentHour: today.hour,
  };
}

function getActiveSlotInfo(): { dateIso: string; hour24: number; isPastHour: boolean; slotKey: string } {
  const clock = getBoiseClockNow();
  const meta = state.forecastData?.metadata;
  const hours = getActiveHoursList();
  const hourData = hours[state.activeHour];
  const hour24 = hourData?.hour_local ?? 8 + state.activeHour;

  const dateIso =
    state.activeDay === "today"
      ? meta?.today_date_iso || clock.todayIso
      : meta?.yesterday_date_iso || clock.yesterdayIso;

  const isPastHour =
    state.activeDay === "yesterday" || (state.activeDay === "today" && hour24 < clock.currentHour);

  return {
    dateIso,
    hour24,
    isPastHour,
    slotKey: `${dateIso}_${hour24}`,
  };
}

async function fetchHourVerifications(dateIso: string, hour24: number) {
  const slotKey = `${dateIso}_${hour24}`;
  const existing = state.verificationsBySlot[slotKey];
  if (existing?.loaded || existing?.loading) return;

  const localCell = localStorage.getItem(`thermatics-verified-${dateIso}-${hour24}`);
  state.verificationsBySlot[slotKey] = {
    countsByCell: existing?.countsByCell ?? {},
    userVerified: Boolean(localCell),
    userVerifiedCellId: localCell ? Number(localCell) : null,
    loaded: false,
    loading: true,
  };

  try {
    const res = await fetch(
      `/api/thermals/verifications?date=${encodeURIComponent(dateIso)}&hour=${encodeURIComponent(String(hour24))}`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        countsByCell?: Record<string, number>;
        userVerified?: boolean;
        userVerifiedCellId?: number | null;
      };
      const verifiedCell =
        data.userVerifiedCellId ?? (localCell ? Number(localCell) : null);
      state.verificationsBySlot[slotKey] = {
        countsByCell: data.countsByCell ?? {},
        userVerified: Boolean(data.userVerified || localCell),
        userVerifiedCellId: verifiedCell,
        loaded: true,
        loading: false,
      };
      updateCellVerificationUI();
      return;
    }
  } catch {
    // Offline or endpoint unavailable; keep local state
  }
  state.verificationsBySlot[slotKey].loading = false;
}

function formatBoiseDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BOISE_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function getLiveDayLabels(): { today: string; yesterday: string; retrievedNow: string } {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const retrievedNow = new Intl.DateTimeFormat("en-US", {
    timeZone: BOISE_TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  return {
    today: formatBoiseDate(now),
    yesterday: formatBoiseDate(yesterday),
    retrievedNow,
  };
}

function getActiveHoursList(): ForecastHour[] {
  if (!state.forecastData) return [];
  const dayBlock = state.forecastData.forecast_days?.[state.activeDay];
  if (dayBlock && Array.isArray(dayBlock.forecast_hours) && dayBlock.forecast_hours.length > 0) {
    return dayBlock.forecast_hours;
  }
  return state.forecastData.forecast_hours || [];
}

function getClassificationLevel(prob: number): "low" | "medium" | "high" {
  if (prob < state.lowThreshold) return "low";
  if (prob < state.highThreshold) return "medium";
  return "high";
}

function getColorForLevel(level: "low" | "medium" | "high"): string {
  if (level === "high") return "#22c55e";
  if (level === "medium") return "#eab308";
  return "#ef4444";
}

function getCardinalDirection(angle: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const normalized = ((angle % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return directions[index];
}

function initUiStyleMode() {
  const params = new URLSearchParams(window.location.search);
  const queryStyle = params.get("style");
  const savedStyle = localStorage.getItem("thermatics-ui-style");
  const initial: UiStyleMode =
    queryStyle === "immersive" || queryStyle === "editorial"
      ? queryStyle
      : savedStyle === "immersive"
        ? "immersive"
        : "editorial";

  applyUiStyleMode(initial, false);
}

function applyUiStyleMode(mode: UiStyleMode, persist = true) {
  state.uiStyle = mode;
  document.documentElement.dataset.thermalUi = mode;
  if (persist) {
    localStorage.setItem("thermatics-ui-style", mode);
  }
  document.querySelectorAll<HTMLButtonElement>("[data-ui-style]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.uiStyle === mode));
  });
  if (state.map) {
    setTimeout(() => state.map?.invalidateSize(), 150);
  }
}

function initMap() {
  const mapEl = document.getElementById("thermal-map");
  if (!mapEl) return;

  const params = new URLSearchParams(window.location.search);
  const initialSpot = params.get("spot");
  const startView = initialSpot && BoiseHotspots[initialSpot] ? BoiseHotspots[initialSpot] : BoiseHotspots.reset;

  state.map = L.map(mapEl, {
    center: startView.center,
    zoom: startView.zoom,
    zoomControl: true,
    attributionControl: true,
  });

  state.tileLayers.satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 18,
      attribution: "Tiles &copy; Esri",
    },
  );

  state.tileLayers.topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    subdomains: "abc",
    attribution: "Map data: &copy; OpenStreetMap, SRTM | Map style: &copy; OpenTopoMap",
  });

  state.tileLayers[state.activeBasemap].addTo(state.map);
  state.gridLayerGroup = L.layerGroup().addTo(state.map);

  // Mark Cervidae Peak launch on the map for quick orientation
  L.circleMarker(BoiseHotspots.cervidae.center, {
    radius: 6,
    color: "#ffffff",
    weight: 2,
    fillColor: "#1c5cab",
    fillOpacity: 1,
  })
    .bindTooltip("Cervidae Peak Launch", { direction: "top" })
    .addTo(state.map);
}

async function fetchForecastPayload(): Promise<ForecastPayload> {
  const urls = ["/data/thermal_predictions.json", "/api/forecast", "/static/forecast_predictions.json"];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return (await response.json()) as ForecastPayload;
      }
    } catch {
      // try next fallback URL
    }
  }
  throw new Error("Could not load thermal forecast dataset from any endpoint.");
}

async function loadForecastData() {
  const retrievalDisplay = document.getElementById("retrieval-time-display");
  if (retrievalDisplay) retrievalDisplay.textContent = "Loading…";

  try {
    const data = await fetchForecastPayload();
    state.forecastData = data;

    if (data.metadata?.thresholds) {
      state.lowThreshold = data.metadata.thresholds.low ?? 0.35;
      state.highThreshold = data.metadata.thresholds.high ?? 0.50;
    }

    // Pick current Boise daytime hour if between 8 AM and 6 PM, otherwise default to 1:00 PM (index 5)
    const currentBoiseHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: BOISE_TZ, hour: "numeric", hourCycle: "h23" }).format(new Date()),
    );
    const hours = getActiveHoursList();
    const matchIdx = hours.findIndex((h, idx) => (h.hour_local ?? 8 + idx) === currentBoiseHour && h.is_daylight);
    state.activeHour = matchIdx >= 0 ? matchIdx : Math.min(5, Math.max(0, hours.length - 1));

    updateHeaderMetadata();
    buildHourlyStepper();
    setActiveForecastHour(state.activeHour);
  } catch (err) {
    console.error("Failed to load forecast data:", err);
    if (retrievalDisplay) retrievalDisplay.textContent = "Waiting for pipeline run…";
  }
}

function updateHeaderMetadata() {
  const meta = state.forecastData?.metadata;
  const days = state.forecastData?.forecast_days;
  const liveDates = getLiveDayLabels();

  const todayLabelEl = document.getElementById("label-date-today");
  const yesterdayLabelEl = document.getElementById("label-date-yesterday");
  if (todayLabelEl) todayLabelEl.textContent = days?.today?.date_display || meta?.today_date_display || liveDates.today;
  if (yesterdayLabelEl) yesterdayLabelEl.textContent = days?.yesterday?.date_display || meta?.yesterday_date_display || liveDates.yesterday;

  const retrievalDisplay = document.getElementById("retrieval-time-display");
  if (retrievalDisplay) {
    retrievalDisplay.textContent = meta?.retrieved_at_local || liveDates.retrievedNow;
  }

  const totalCellsEl = document.getElementById("stat-total-cells");
  if (totalCellsEl && meta?.total_cells) {
    totalCellsEl.textContent = String(meta.total_cells);
  }
}

function buildHourlyStepper() {
  const container = document.getElementById("hours-stepper");
  const hours = getActiveHoursList();
  if (!container || hours.length === 0) return;
  container.innerHTML = "";

  hours.forEach((hObj, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `th-hour-btn ${idx === state.activeHour ? "active" : ""}`;
    btn.dataset.hour = String(idx);

    const hour24 = hObj.hour_local ?? 8 + idx;
    const tagText = hour24 === 12 ? "NOON" : hour24 < 12 ? "MORNING" : hour24 <= 17 ? "PEAK" : "EVENING";
    const icon = hObj.is_daylight ? "☀️" : "🌇";

    btn.innerHTML = `
      <span class="th-hour-tag">${tagText}</span>
      <span class="th-hour-time">${hObj.local_time_display}</span>
      <span class="th-hour-icon" aria-hidden="true">${icon}</span>
    `;

    btn.addEventListener("click", () => setActiveForecastHour(idx));
    container.appendChild(btn);
  });
}

function setActiveForecastHour(hourIndex: number) {
  const hours = getActiveHoursList();
  if (hours.length === 0) return;
  state.activeHour = Math.max(0, Math.min(hourIndex, hours.length - 1));

  document.querySelectorAll<HTMLButtonElement>(".th-hour-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.hour) === state.activeHour);
  });

  const hourData = hours[state.activeHour];
  const meta = state.forecastData?.metadata;
  const days = state.forecastData?.forecast_days;
  const liveDates = getLiveDayLabels();
  const activeDateStr =
    days?.[state.activeDay]?.date_display ||
    (state.activeDay === "today" ? meta?.today_date_display || liveDates.today : meta?.yesterday_date_display || liveDates.yesterday);
  const dayWord = state.activeDay === "today" ? "Today" : "Yesterday";

  if (hourData) {
    const activeHourDisplay = document.getElementById("active-hour-display");
    if (activeHourDisplay) {
      activeHourDisplay.textContent = `${dayWord} · ${hourData.local_time_display}`;
    }

    const activeDateDisplay = document.getElementById("active-date-display");
    if (activeDateDisplay) {
      activeDateDisplay.textContent = activeDateStr;
    }

    const daylightBadge = document.getElementById("daylight-status-badge");
    if (daylightBadge) {
      if (hourData.is_daylight) {
        daylightBadge.className = "th-daylight-badge";
        daylightBadge.textContent = `☀️ Daylight (Sun ${hourData.sun_elevation_deg.toFixed(1)}°)`;
      } else {
        daylightBadge.className = "th-daylight-badge night";
        daylightBadge.textContent = `🌇 Dusk / Low Sun (${hourData.sun_elevation_deg.toFixed(1)}°)`;
      }
    }
  }

  renderMapGrid();
  updateHourlyWeatherDisplay();
  updateDomainStatistics();
  const slot = getActiveSlotInfo();
  void fetchHourVerifications(slot.dateIso, slot.hour24);
  updateCellInspector();
}

function updateHourlyWeatherDisplay() {
  const hourData = getActiveHoursList()[state.activeHour];
  if (!hourData?.weather_summary) return;

  const w = hourData.weather_summary;
  const setTxt = (id: string, val: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setTxt("weather-temp", `${w.temp_c}°C (${w.temp_f}°F)`);
  setTxt("weather-wind", `${w.wind_speed_mph} mph @ ${Math.round(w.wind_dir_deg)}°`);
  setTxt("weather-blh", `${Math.round(w.blh_m)} m`);
  setTxt("weather-cape", `${Math.round(w.cape_jkg)} J/kg`);
}

function renderMapGrid() {
  const hourData = getActiveHoursList()[state.activeHour];
  if (!hourData?.cells || !state.gridLayerGroup) return;

  state.gridLayerGroup.clearLayers();
  state.cellRectangles = [];

  const resolution = 0.015;
  const halfStep = resolution / 2.0;

  hourData.cells.forEach((cell) => {
    const modelPred = cell.predictions[state.activeModel];
    if (!modelPred) return;

    const prob = modelPred.probability;
    const level = getClassificationLevel(prob);

    if (state.activeFilter === "high" && level !== "high") return;
    if (state.activeFilter === "med-high" && level === "low") return;

    const fillColor = getColorForLevel(level);
    const bounds: L.LatLngBoundsExpression = [
      [cell.lat - halfStep, cell.lon - halfStep],
      [cell.lat + halfStep, cell.lon + halfStep],
    ];

    const isSelected = state.selectedCellId === cell.id;
    const rect = L.rectangle(bounds, {
      fillColor,
      fillOpacity: isSelected ? 0.85 : 0.60,
      color: isSelected ? "#ffffff" : fillColor,
      weight: isSelected ? 2.5 : 0.8,
      className: "thermal-grid-cell",
    });

    const pct = Math.round(prob * 100);
    const label = level === "high" ? "High Chance" : level === "medium" ? "Medium Chance" : "Low Chance";
    rect.bindTooltip(
      `<div style="font-size: 12px; line-height: 1.35;">
        <strong style="color: ${fillColor};">${pct}% ${label}</strong><br/>
        <span>${cell.zone} · ${Math.round(cell.elevation)} m (${Math.round(cell.elevation * 3.28084)} ft)</span>
      </div>`,
      { sticky: true, opacity: 0.95 },
    );

    rect.on("click", () => selectCell(cell.id));
    rect.addTo(state.gridLayerGroup!);
    state.cellRectangles.push({ id: cell.id, rect, cell });
  });
}

function selectCell(cellId: number) {
  state.selectedCellId = cellId;
  updateSelectedCellOutline();
  updateCellInspector();
}

function updateSelectedCellOutline() {
  state.cellRectangles.forEach((item) => {
    const isSelected = item.id === state.selectedCellId;
    item.rect.setStyle({
      fillOpacity: isSelected ? 0.88 : 0.60,
      color: isSelected ? "#ffffff" : item.rect.options.fillColor,
      weight: isSelected ? 2.5 : 0.8,
    });
  });
}

function updateCellInspector() {
  const emptyState = document.getElementById("inspector-empty");
  const content = document.getElementById("inspector-content");
  if (!emptyState || !content) return;

  if (state.selectedCellId === null || !state.forecastData) {
    emptyState.hidden = false;
    content.hidden = true;
    return;
  }

  const hourData = getActiveHoursList()[state.activeHour];
  const cell = hourData?.cells.find((c) => c.id === state.selectedCellId);
  if (!hourData || !cell) return;

  emptyState.hidden = true;
  content.hidden = false;

  const setTxt = (id: string, val: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setTxt("cell-zone-name", cell.zone);
  setTxt("cell-id-tag", `Cell #${cell.id} (${cell.lat.toFixed(3)}, ${cell.lon.toFixed(3)})`);
  setTxt("cell-elev", `${Math.round(cell.elevation)} m`);
  setTxt("cell-elev-ft", `${Math.round(cell.elevation * 3.28084).toLocaleString("en-US")} ft MSL`);
  setTxt("cell-slope", `${cell.mean_slope.toFixed(1)}°`);
  setTxt(
    "cell-slope-steepness",
    cell.mean_slope > 20 ? "Steep Ridge" : cell.mean_slope > 10 ? "Moderate Slope" : "Gentle / Flat",
  );
  setTxt("cell-aspect", `${Math.round(cell.mean_aspect)}°`);
  setTxt("cell-aspect-cardinal", `Faces ${getCardinalDirection(cell.mean_aspect)}`);
  setTxt("cell-absorbed", `${(cell.absorbed_radiation * 100).toFixed(0)}%`);

  const models: Array<{ key: ModelKey; badgeId: string; fillId: string }> = [
    { key: "ensemble", badgeId: "badge-ensemble", fillId: "fill-ensemble" },
    { key: "lightgbm", badgeId: "badge-lightgbm", fillId: "fill-lightgbm" },
    { key: "xgboost", badgeId: "badge-xgboost", fillId: "fill-xgboost" },
  ];

  models.forEach((m) => {
    const pred = cell.predictions[m.key];
    const badgeEl = document.getElementById(m.badgeId);
    const fillEl = document.getElementById(m.fillId);
    if (pred && badgeEl && fillEl) {
      const pct = Math.round(pred.probability * 100);
      const level = getClassificationLevel(pred.probability);
      const label = level === "high" ? "High" : level === "medium" ? "Medium" : "Low";
      const badgeClass = level === "high" ? "th-badge-high" : level === "medium" ? "th-badge-med" : "th-badge-low";
      const fillClass = level === "high" ? "th-fill-high" : level === "medium" ? "th-fill-med" : "th-fill-low";

      badgeEl.className = `th-score-badge ${badgeClass}`;
      badgeEl.textContent = `${label} (${pct}%)`;
      fillEl.className = `th-progress-fill ${fillClass}`;
      fillEl.style.width = `${pct}%`;
    }
  });

  setTxt("cell-hour-label", hourData.local_time_display);
  const w = hourData.weather_summary;
  setTxt("cell-temp", `${w.temp_c}°C (${w.temp_f}°F)`);
  setTxt("cell-wind", `${w.wind_speed_mph} mph`);
  setTxt("cell-blh", `${Math.round(w.blh_m)} m`);

  const ensProb = cell.predictions.ensemble.probability;
  const triggerEl = document.getElementById("cell-trigger");
  if (triggerEl) {
    if (ensProb >= state.highThreshold) {
      triggerEl.style.color = "var(--th-high)";
      triggerEl.textContent = "High Chance";
    } else if (ensProb >= state.lowThreshold) {
      triggerEl.style.color = "var(--th-med)";
      triggerEl.textContent = "Moderate";
    } else {
      triggerEl.style.color = "var(--th-low)";
      triggerEl.textContent = "Weak / Low";
    }
  }

  updateCellVerificationUI();
}

function updateCellVerificationUI() {
  const btn = document.getElementById("btn-verify-thermal") as HTMLButtonElement | null;
  const countEl = document.getElementById("cell-verify-count");
  const statusEl = document.getElementById("cell-verify-status");
  if (!btn || !countEl || !statusEl || state.selectedCellId === null) return;

  const { dateIso, hour24, isPastHour, slotKey } = getActiveSlotInfo();
  const slot = state.verificationsBySlot[slotKey];
  const localCell = localStorage.getItem(`thermatics-verified-${dateIso}-${hour24}`);
  const cellCount = slot?.countsByCell?.[String(state.selectedCellId)] ?? 0;
  countEl.textContent = cellCount === 1 ? "1 verified" : `${cellCount} verified`;

  const userVerified = Boolean(slot?.userVerified || localCell);
  const verifiedCellId = slot?.userVerifiedCellId ?? (localCell ? Number(localCell) : null);

  if (!isPastHour) {
    btn.disabled = true;
    btn.textContent = "Verify thermal";
    statusEl.textContent = "Verification opens once this hour has passed.";
    return;
  }

  if (userVerified) {
    btn.disabled = true;
    btn.textContent =
      verifiedCellId === state.selectedCellId
        ? "✓ Verified in this cell"
        : verifiedCellId
          ? `✓ Verified (Cell #${verifiedCellId})`
          : "✓ Verified for this hour";
    statusEl.textContent = "You have already submitted a thermal verification for this hour (limit 1 per hour).";
    return;
  }

  btn.disabled = false;
  btn.textContent = "Verify thermal";
  statusEl.textContent = `Confirm you encountered a thermal in Cell #${state.selectedCellId} during this past hour.`;
}

async function submitThermalVerification() {
  if (state.selectedCellId === null) return;
  const btn = document.getElementById("btn-verify-thermal") as HTMLButtonElement | null;
  const statusEl = document.getElementById("cell-verify-status");
  const { dateIso, hour24, isPastHour, slotKey } = getActiveSlotInfo();
  if (!isPastHour) {
    updateCellVerificationUI();
    return;
  }

  const cellId = state.selectedCellId;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Submitting…";
  }

  try {
    const res = await fetch("/api/thermals/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dateIso, hour: hour24, cellId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      countsByCell?: Record<string, number>;
      userVerifiedCellId?: number | null;
    };

    if (res.ok || res.status === 409) {
      const recordedCell = body.userVerifiedCellId ?? cellId;
      localStorage.setItem(`thermatics-verified-${dateIso}-${hour24}`, String(recordedCell));
      state.verificationsBySlot[slotKey] = {
        countsByCell: body.countsByCell ?? state.verificationsBySlot[slotKey]?.countsByCell ?? {},
        userVerified: true,
        userVerifiedCellId: recordedCell,
        loaded: true,
        loading: false,
      };
      updateCellVerificationUI();
      return;
    }

    if (statusEl) {
      statusEl.textContent = body.error || "Could not record verification.";
    }
  } catch {
    if (statusEl) {
      statusEl.textContent = "Network error while submitting verification.";
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Verify thermal";
  }
}

function updateDomainStatistics() {
  const hourData = getActiveHoursList()[state.activeHour];
  if (!hourData?.cells) return;

  let highCount = 0;
  let medCount = 0;
  let lowCount = 0;
  let probSum = 0;
  const total = hourData.cells.length || 1;

  for (const c of hourData.cells) {
    const p = c.predictions[state.activeModel]?.probability ?? 0;
    probSum += p;
    if (p >= state.highThreshold) highCount++;
    else if (p >= state.lowThreshold) medCount++;
    else lowCount++;
  }

  const highPct = ((highCount / total) * 100).toFixed(1);
  const medPct = ((medCount / total) * 100).toFixed(1);
  const lowPct = ((lowCount / total) * 100).toFixed(1);
  const meanPct = Math.round((probSum / total) * 100);

  const setTxt = (id: string, val: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setTxt(
    "legend-model-name",
    state.activeModel === "ensemble"
      ? "Ensemble Consensus"
      : state.activeModel === "lightgbm"
        ? "LightGBM Trees"
        : "XGBoost Trees",
  );
  setTxt("stat-high-pct", `${highPct}% (${highCount} cells)`);
  setTxt("stat-med-pct", `${medPct}% (${medCount} cells)`);
  setTxt("stat-low-pct", `${lowPct}% (${lowCount} cells)`);
  setTxt("stat-mean-prob", `${meanPct}%`);

  document.querySelectorAll(".val-thresh-low").forEach((el) => {
    el.textContent = `${Math.round(state.lowThreshold * 100)}%`;
  });
  document.querySelectorAll(".val-thresh-high").forEach((el) => {
    el.textContent = `${Math.round(state.highThreshold * 100)}%`;
  });
}

function setupEventListeners() {
  // Day Switcher (Today vs Yesterday)
  document.querySelectorAll<HTMLButtonElement>("#thermal-day-tabs button[data-day]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>("#thermal-day-tabs button[data-day]").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
      });
      btn.setAttribute("aria-pressed", "true");
      state.activeDay = (btn.dataset.day as DayKey) || "today";
      buildHourlyStepper();
      setActiveForecastHour(state.activeHour);
    });
  });

  // Model Switcher
  document.querySelectorAll<HTMLButtonElement>("#thermal-model-tabs button[data-model]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>("#thermal-model-tabs button[data-model]").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
      });
      btn.setAttribute("aria-pressed", "true");
      state.activeModel = (btn.dataset.model as ModelKey) || "ensemble";
      renderMapGrid();
      updateDomainStatistics();
      updateCellInspector();
    });
  });

  // UI Style Switcher (Editorial vs Immersive Dark)
  document.querySelectorAll<HTMLButtonElement>("[data-ui-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn.dataset.uiStyle as UiStyleMode) || "editorial";
      applyUiStyleMode(mode, true);
    });
  });

  // Basemap Switcher
  document.querySelectorAll<HTMLButtonElement>("[data-basemap]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const requested = btn.dataset.basemap as BasemapKey;
      if (!requested || requested === state.activeBasemap || !state.map) return;

      document.querySelectorAll<HTMLButtonElement>("[data-basemap]").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
      });
      btn.setAttribute("aria-pressed", "true");

      state.map.removeLayer(state.tileLayers[state.activeBasemap]);
      state.activeBasemap = requested;
      state.tileLayers[state.activeBasemap].addTo(state.map);
    });
  });

  // Cell Filter
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
      });
      btn.setAttribute("aria-pressed", "true");
      state.activeFilter = (btn.dataset.filter as FilterKey) || "all";
      renderMapGrid();
    });
  });

  // Quick-Fly Hotspots
  document.querySelectorAll<HTMLButtonElement>(".quick-fly").forEach((btn) => {
    btn.addEventListener("click", () => {
      const spotKey = btn.dataset.spot;
      const spot = spotKey ? BoiseHotspots[spotKey] : null;
      if (spot && state.map) {
        state.map.flyTo(spot.center, spot.zoom, { duration: 1.1 });
      }
    });
  });

  // Clear Selected Cell
  document.getElementById("btn-close-inspector")?.addEventListener("click", () => {
    state.selectedCellId = null;
    updateSelectedCellOutline();
    updateCellInspector();
  });

  // Verify Thermal Button
  document.getElementById("btn-verify-thermal")?.addEventListener("click", () => {
    void submitThermalVerification();
  });

  // Threshold Modal
  const modal = document.getElementById("threshold-modal");
  document.getElementById("btn-open-thresholds")?.addEventListener("click", () => {
    if (modal) modal.hidden = false;
  });
  document.getElementById("btn-close-thresholds")?.addEventListener("click", () => {
    if (modal) modal.hidden = true;
  });
  document.getElementById("btn-apply-thresholds")?.addEventListener("click", () => {
    if (modal) modal.hidden = true;
  });

  const sliderLow = document.getElementById("slider-low-thresh") as HTMLInputElement | null;
  const sliderHigh = document.getElementById("slider-high-thresh") as HTMLInputElement | null;
  const dispLow = document.getElementById("display-low-thresh");
  const dispHigh = document.getElementById("display-high-thresh");

  sliderLow?.addEventListener("input", () => {
    const val = parseInt(sliderLow.value, 10) / 100.0;
    if (val < state.highThreshold) {
      state.lowThreshold = val;
      if (dispLow) dispLow.textContent = `${Math.round(val * 100)}%`;
      renderMapGrid();
      updateDomainStatistics();
      updateCellInspector();
    }
  });

  sliderHigh?.addEventListener("input", () => {
    const val = parseInt(sliderHigh.value, 10) / 100.0;
    if (val > state.lowThreshold) {
      state.highThreshold = val;
      if (dispHigh) dispHigh.textContent = `${Math.round(val * 100)}%`;
      renderMapGrid();
      updateDomainStatistics();
      updateCellInspector();
    }
  });

  document.getElementById("btn-reset-thresholds")?.addEventListener("click", () => {
    state.lowThreshold = 0.35;
    state.highThreshold = 0.50;
    if (sliderLow) sliderLow.value = "35";
    if (sliderHigh) sliderHigh.value = "50";
    if (dispLow) dispLow.textContent = "35%";
    if (dispHigh) dispHigh.textContent = "50%";
    renderMapGrid();
    updateDomainStatistics();
    updateCellInspector();
  });
}

export function mountThermalPredictionPage() {
  initUiStyleMode();
  initMap();
  setupEventListeners();
  loadForecastData();
}

if (document.getElementById("thermal-map")) {
  mountThermalPredictionPage();
}
