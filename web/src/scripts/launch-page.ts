// Launch page: day tabs and a model switch scope the meteogram and the NWS
// charts below them. All forecast data is read from /data at view time, so the
// page is always as fresh as the dataset without rebuilding the site.

import { parseForecastManifestJson, parseModelCatalogueJson, parseSiteContextJson } from "@azohra/meteo.briefing/contract";
import type { ForecastManifest, ModelCatalogue, SiteForecast } from "@azohra/meteo.briefing/contract";
import { localDateKey, localHourOfDay, localInstantMs, runFreshness } from "@azohra/meteo.briefing/derive";
import { buildKeySpec, buildMeteogramScene, renderKeySvg, renderMeteogramSvg } from "@azohra/meteo.briefing/meteogram";
import { loadForecast } from "@azohra/meteo.briefing/transport";
import { windWindow, compassPoint, type Launch } from "../lib/launches.ts";
import { NwsChart, type NwsHour } from "../lib/nws-chart.ts";
import { DATA_BASE } from "../lib/site.ts";
import { fmt, ft, relativeTime } from "../lib/units.ts";
import { Sunlight, type CloudSeries } from "./sunlight.ts";

// Short-range high-resolution models first, then regional, global, and the ensemble.
const MODEL_ORDER = ["hrrr-conus", "hrdps-continental", "rrfs", "rdps", "gfs", "gdps", "geps"];
const HOUR_MS = 3_600_000;
const DAY_START = 7;
const DAY_END = 21;
const DAYS = 7;

interface NwsSiteDocument {
  updateTime: string | null;
  generatedAt: string;
  grid: { office: string; x: number; y: number; elevationM: number | null };
  pageUrl: string;
  hours: NwsHour[];
  periods: { name: string; startTime: string; isDaytime: boolean; shortForecast: string; detailedForecast: string }[];
}

interface NwsOfficeDocument {
  office: string;
  products: {
    afd: { issuanceTime: string; text: string } | null;
    srg: { issuanceTime: string; text: string } | null;
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const launch = JSON.parse($("launch-config").textContent ?? "{}") as Launch;
const tz = launch.timeZone;
const arc = windWindow(launch);
let sample = false;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${DATA_BASE}/${path}`);
    if (response.headers.get("x-sample-data")) sample = true;
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function dayLabel(dateKey: string, index: number) {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  const date = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date);
}

function daySub(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${dateKey}T12:00:00Z`));
}

function nextDateKeys(count: number) {
  const keys: string[] = [];
  for (let t = Date.now(); keys.length < count; t += 3_600_000) {
    const key = localDateKey(new Date(t).toISOString(), tz);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

const inDay = (validAt: string, dateKey: string) => {
  if (localDateKey(validAt, tz) !== dateKey) return false;
  const hour = localHourOfDay(validAt, tz);
  return hour >= DAY_START && hour <= DAY_END;
};

function button(label: string, sub: string | null, pressed: boolean, disabled: boolean, onClick: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (sub) {
    const small = document.createElement("small");
    small.textContent = sub;
    b.appendChild(small);
  }
  b.setAttribute("aria-pressed", String(pressed));
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

// ── state ────────────────────────────────────────────────────────────────

const days = nextDateKeys(DAYS);
let day = days[0];
let model: string | null = null;
let catalogue: ModelCatalogue | null = null;
let launchElevationM: number | null = null;
// Manifests are small and say which hours each model covers; a model's profile
// is only downloaded when it is selected.
const manifests = new Map<string, ForecastManifest>();
const profiles = new Map<string, { profile: SiteForecast; referenceTime: string; generatedAt: string; stale: boolean } | null>();
let nws: NwsSiteDocument | null = null;
let chart: NwsChart | null = null;
const sunlight = new Sunlight(launch);

async function profileFor(slug: string) {
  if (!profiles.has(slug)) {
    const loaded = await loadForecast({ fetch: (url) => fetch(url), baseUrl: DATA_BASE, modelSlug: slug, siteSlug: launch.slug }).catch(() => null);
    profiles.set(
      slug,
      loaded && !("miss" in loaded)
        ? { profile: loaded.profile, referenceTime: loaded.manifest.referenceTime, generatedAt: loaded.manifest.generatedAt, stale: loaded.stale }
        : null,
    );
  }
  return profiles.get(slug) ?? null;
}

function modelEntry(slug: string) {
  return catalogue?.models.find((m) => m.slug === slug) ?? null;
}

async function loadManifest(slug: string) {
  const text = await fetch(`${DATA_BASE}/${slug}/manifest.json`)
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  const manifest = text ? parseForecastManifestJson(text) : null;
  if (manifest && manifest.sites.some((s) => s.slug === launch.slug)) manifests.set(slug, manifest);
}

/** True when the model's published run has hours inside the pilots' day for `dateKey`. */
function covers(slug: string, dateKey: string) {
  const m = manifests.get(slug);
  if (!m) return false;
  const reference = Date.parse(m.referenceTime);
  const first = reference + m.firstForecastHour * HOUR_MS;
  const last = reference + m.lastForecastHour * HOUR_MS;
  return first <= localInstantMs(dateKey, DAY_END, tz) && last >= localInstantMs(dateKey, DAY_START, tz);
}

function modelLabel(slug: string) {
  return modelEntry(slug)?.label.replace(" CONUS", "").replace(" continental", "") ?? slug;
}

async function selectModel(slug: string) {
  model = slug;
  $("meteogram").classList.add("is-loading");
  render();
  await profileFor(slug);
  $("meteogram").classList.remove("is-loading");
  if (model === slug) render();
}

// ── rendering ────────────────────────────────────────────────────────────

function renderDayTabs() {
  const host = $("day-tabs");
  host.replaceChildren(
    ...days.map((key, i) => {
      const hasModel = MODEL_ORDER.some((slug) => covers(slug, key));
      const hasNws = nws?.hours.some((h) => inDay(h.validAt, key)) ?? false;
      return button(dayLabel(key, i), daySub(key), key === day, !hasModel && !hasNws, () => {
        day = key;
        render();
      });
    }),
  );
}

function renderModelTabs(available: string[]) {
  const host = $("model-tabs");
  host.replaceChildren(
    ...available.map((slug) => {
      const entry = modelEntry(slug);
      const sub = entry ? `${entry.gridKm} km${entry.kind === "ensemble" ? " · ens" : ""}` : null;
      return button(modelLabel(slug), sub, slug === model, false, () => selectModel(slug));
    }),
  );
}

function renderMeteogram() {
  const frame = $("meteogram");
  const meta = $("meteogram-meta");
  const title = $("meteogram-title");
  const key = $("meteogram-key");
  const loaded = model ? profiles.get(model) : null;
  const entry = model ? modelEntry(model) : null;
  title.textContent = entry
    ? `Soaring meteogram · ${entry.label}, ${entry.gridKm} km${entry.kind === "ensemble" ? " ensemble" : ""}`
    : "Soaring meteogram";

  if (!loaded) {
    meta.textContent = "";
    key.replaceChildren();
    const loading = model !== null && !profiles.has(model);
    frame.innerHTML = `<p class="chart-status">${loading ? "Loading the model forecast…" : "Model forecasts for this launch are not published yet."}</p>`;
    return;
  }

  const freshness = entry
    ? runFreshness({ referenceTime: loaded.referenceTime, generatedAt: loaded.generatedAt }, entry, new Date().toISOString(), { currentIntervals: 1, staleAfterIntervals: 3 })
    : "current";
  const run = new Date(loaded.referenceTime);
  meta.textContent = `Run ${String(run.getUTCHours()).padStart(2, "0")}Z · published ${relativeTime(loaded.generatedAt)}${
    freshness === "stale" ? " · older than expected" : freshness === "delayed" ? " · newer run is late" : ""
  }${loaded.stale ? " · update in progress" : ""}`;

  const hours = loaded.profile.hours.filter((h) => inDay(h.validAt, day));
  if (hours.length === 0) {
    const other = MODEL_ORDER.find((slug) => slug !== model && covers(slug, day));
    frame.innerHTML = "";
    const p = document.createElement("p");
    p.className = "chart-status";
    p.textContent = `${modelLabel(model ?? "")} does not reach this day. `;
    if (other) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "button secondary";
      b.textContent = `Show ${modelLabel(other)}`;
      b.addEventListener("click", () => selectModel(other));
      p.appendChild(b);
    }
    frame.appendChild(p);
    key.replaceChildren();
    return;
  }

  const width = Math.max(frame.clientWidth || 640, 320);
  const scene = buildMeteogramScene(loaded.profile, {
    timeZone: tz,
    hours,
    launch: launchElevationM != null ? { name: launch.name, elevationM: launchElevationM } : null,
    launchWindows: [arc],
    capabilities: entry?.capabilities,
    hourLabel: "12h",
    widthPx: width,
    minColumnWidthPx: 40,
  });
  frame.innerHTML = renderMeteogramSvg(scene, { idPrefix: `mg-${launch.slug}` });
  key.innerHTML = renderKeySvg(buildKeySpec(scene), { idPrefix: `mg-key-${launch.slug}` });
  // The SVG has only a viewBox; pin it to the scene's pixel size so narrow
  // screens scroll sideways instead of shrinking the chart.
  for (const svg of [frame.querySelector("svg"), key.querySelector("svg")]) {
    const box = svg?.viewBox.baseVal;
    if (svg && box && box.width > 0) svg.style.width = `${box.width}px`;
  }
}

function renderNws() {
  const meta = $("nws-meta");
  const link = $("nws-link") as HTMLAnchorElement;
  if (!nws) {
    meta.textContent = "";
    link.hidden = true;
    $("nws-charts").innerHTML = `<p class="chart-status">The National Weather Service forecast is not published yet.</p>`;
    return;
  }
  meta.textContent = `Grid ${nws.grid.office} ${nws.grid.x},${nws.grid.y}${
    nws.grid.elevationM != null ? ` (grid elevation ${fmt(ft(nws.grid.elevationM))} ft)` : ""
  } · updated ${nws.updateTime ? relativeTime(nws.updateTime) : "–"}`;
  link.href = nws.pageUrl;
  link.hidden = false;
  if (!chart) {
    chart = new NwsChart($("nws-charts"), {
      windMinMph: launch.windMinMph,
      windMaxMph: launch.windMaxMph,
      gustMaxMph: launch.gustMaxMph,
      window: arc,
      windowLabel: `${compassPoint(launch.facingDeg)} ±${launch.windArcHalfWidthDeg}°`,
    }, tz);
  }
  chart.setHours(nws.hours.filter((h) => inDay(h.validAt, day)));
}

/** The selected model's total cloud cover (ensemble median), for dimming the sunlight map. */
function cloudsFor(slug: string | null): CloudSeries | null {
  const loaded = slug ? profiles.get(slug) : null;
  const entry = slug ? modelEntry(slug) : null;
  if (!slug || !loaded) return null;
  const points: CloudSeries["points"] = [];
  for (const hour of loaded.profile.hours) {
    const v = hour.surface.cloudCoverPercent;
    const percent = typeof v === "number" ? v : v.p50;
    if (percent != null) points.push({ ms: Date.parse(hour.validAt), fraction: percent / 100 });
  }
  return points.length ? { label: `${modelLabel(slug)}${entry ? ` ${entry.gridKm} km` : ""}`, points } : null;
}

function render() {
  renderDayTabs();
  renderModelTabs(MODEL_ORDER.filter((slug) => manifests.has(slug)));
  renderMeteogram();
  renderNws();
  sunlight.setDay(day, cloudsFor(model));
}

function renderText(office: NwsOfficeDocument | null) {
  const list = $("nws-periods");
  list.replaceChildren();
  for (const period of nws?.periods ?? []) {
    const li = document.createElement("li");
    const h = document.createElement("h3");
    h.textContent = period.name;
    const p = document.createElement("p");
    p.textContent = period.detailedForecast;
    li.append(h, p);
    list.appendChild(li);
  }
  if (!nws?.periods.length) list.innerHTML = `<li class="muted">No text forecast available.</li>`;

  const products = $("nws-products");
  products.replaceChildren();
  const add = (label: string, product: { issuanceTime: string; text: string } | null | undefined) => {
    if (!product) return;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${label} · issued ${relativeTime(product.issuanceTime)}`;
    const pre = document.createElement("pre");
    pre.className = "product";
    pre.textContent = product.text;
    details.append(summary, pre);
    products.appendChild(details);
  };
  add("Soaring Forecast", office?.products.srg);
  add(`Area Forecast Discussion (NWS ${office?.office ?? ""})`, office?.products.afd);
}

async function start() {
  for (const id of ["meteogram", "nws-charts"]) $(id).classList.add("is-loading");
  const [modelsJson, contextJson, nwsDoc] = await Promise.all([
    getJson<unknown>("models.json"),
    getJson<unknown>("site-context.json"),
    getJson<NwsSiteDocument>(`nws/sites/${launch.slug}.json`),
    ...MODEL_ORDER.map(loadManifest),
  ]);
  catalogue = modelsJson ? parseModelCatalogueJson(JSON.stringify(modelsJson)) : null;
  const context = contextJson ? parseSiteContextJson(JSON.stringify(contextJson)) : null;
  launchElevationM = context?.sites[launch.slug]?.elevation.elevationM ?? null;
  nws = nwsDoc;

  if (launchElevationM != null) {
    $("launch-elevation").textContent = `${fmt(ft(launchElevationM))} ft`;
    $("launch-elevation-item").hidden = false;
  }

  // Default: the sharpest model that covers today (or any published one).
  model = MODEL_ORDER.find((slug) => covers(slug, day)) ?? MODEL_ORDER.find((slug) => manifests.has(slug)) ?? null;
  if (model) await profileFor(model);

  if (sample) $("sample-notice").hidden = false;
  for (const id of ["meteogram", "nws-charts"]) $(id).classList.remove("is-loading");
  render();

  const office = nws ? await getJson<NwsOfficeDocument>(`nws/offices/${nws.grid.office}.json`) : null;
  renderText(office);
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderMeteogram, 150);
});

start();
