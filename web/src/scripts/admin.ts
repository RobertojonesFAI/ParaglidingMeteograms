// Admin page: lists launches from the repository (through the Worker) and
// creates or updates one launch per save. The Worker commits the change; the
// forecasts and the site rebuild follow automatically.

import { compassPoint, slugify, validateLaunchInput, type Launch } from "../lib/launches.ts";
import { mountPicker } from "./map.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("admin-status");
const form = $("launch-form") as HTMLFormElement;
const errors = $("form-errors");
const saveStatus = $("save-status");
let launches: Launch[] = [];
let editing: Launch | null = null;

interface ApiError {
  error?: string;
  details?: string[];
}
interface ListResponse extends ApiError {
  email: string;
  launches: Launch[];
}
interface SaveResponse extends ApiError {
  commitUrl: string;
}

const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const picker = mountPicker($("picker"), (lat, lon) => {
  field("latitude").value = lat.toFixed(5);
  field("longitude").value = lon.toFixed(5);
}, []);

for (const name of ["latitude", "longitude"]) {
  field(name).addEventListener("change", () => picker.set(Number(field("latitude").value), Number(field("longitude").value)));
}

field("name").addEventListener("input", () => {
  if (!editing) $("slug-hint").textContent = field("name").value ? `Address: /launches/${slugify(field("name").value)}` : "";
});

function setFacing(deg: number) {
  const snapped = (Math.round(deg / 22.5) * 22.5) % 360;
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name="facing"]')) input.checked = Number(input.value) === snapped;
}

function openForm(launch: Launch | null) {
  editing = launch;
  form.hidden = false;
  errors.replaceChildren();
  saveStatus.textContent = "";
  $("form-title").textContent = launch ? `Edit ${launch.name}` : "Add a launch";
  field("name").value = launch?.name ?? "";
  field("region").value = launch?.region ?? "";
  field("latitude").value = launch ? String(launch.latitude) : "";
  field("longitude").value = launch ? String(launch.longitude) : "";
  field("timeZone").value = launch?.timeZone ?? "America/Boise";
  field("windArcHalfWidthDeg").value = String(launch?.windArcHalfWidthDeg ?? 45);
  field("windMinMph").value = String(launch?.windMinMph ?? 5);
  field("windMaxMph").value = String(launch?.windMaxMph ?? 15);
  field("gustMaxMph").value = String(launch?.gustMaxMph ?? 20);
  field("notes").value = launch?.notes ?? "";
  if (launch) setFacing(launch.facingDeg);
  else for (const input of form.querySelectorAll<HTMLInputElement>('input[name="facing"]')) input.checked = false;
  $("slug-hint").textContent = launch ? `Address: /launches/${launch.slug} (cannot change)` : "";
  picker.invalidate();
  if (launch) picker.set(launch.latitude, launch.longitude);
  else picker.clear();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  field("name").focus({ preventScroll: true });
}

function renderList() {
  const rows = $("launch-rows");
  rows.replaceChildren();
  for (const launch of launches) {
    const tr = document.createElement("tr");
    const cells = [
      launch.name,
      launch.slug,
      `${launch.latitude.toFixed(4)}, ${launch.longitude.toFixed(4)}`,
      `${compassPoint(launch.facingDeg)} ±${launch.windArcHalfWidthDeg}°`,
      `${launch.windMinMph}–${launch.windMaxMph}, gust ${launch.gustMaxMph}`,
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i < 2) td.className = "text";
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openForm(launch));
    td.appendChild(edit);
    tr.appendChild(td);
    rows.appendChild(tr);
  }
}

async function load() {
  let response: Response;
  try {
    response = await fetch("/api/admin/launches", { headers: { accept: "application/json" } });
  } catch {
    status.textContent = "Could not reach the admin API.";
    return;
  }
  const body = (await response.json().catch(() => ({}))) as ListResponse;
  if (response.status === 401 || response.status === 403) {
    status.textContent = "You need to sign in with an admin account. Reload the page to sign in through Cloudflare Access.";
    return;
  }
  if (!response.ok) {
    status.textContent = `The admin API is not ready: ${body.error ?? response.status}.`;
    return;
  }
  launches = body.launches;
  status.textContent = `Signed in as ${body.email}.`;
  $("list-card").hidden = false;
  renderList();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errors.replaceChildren();
  const facing = form.querySelector<HTMLInputElement>('input[name="facing"]:checked');
  const input = {
    name: field("name").value,
    slug: editing?.slug,
    region: field("region").value,
    latitude: field("latitude").value,
    longitude: field("longitude").value,
    timeZone: field("timeZone").value,
    facingDeg: facing ? facing.value : "",
    windArcHalfWidthDeg: field("windArcHalfWidthDeg").value,
    windMinMph: field("windMinMph").value,
    windMaxMph: field("windMaxMph").value,
    gustMaxMph: field("gustMaxMph").value,
    notes: field("notes").value,
  };
  const checked = validateLaunchInput(input);
  const showErrors = (list: string[]) => {
    for (const message of list) {
      const li = document.createElement("li");
      li.textContent = message;
      errors.appendChild(li);
    }
  };
  if ("errors" in checked) {
    showErrors(checked.errors);
    return;
  }

  const save = $("save") as HTMLButtonElement;
  save.disabled = true;
  saveStatus.textContent = "Saving…";
  try {
    const response = await fetch("/api/admin/launches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: editing ? "update" : "create", launch: checked.launch }),
    });
    const body = (await response.json().catch(() => ({}))) as SaveResponse;
    if (!response.ok) {
      saveStatus.textContent = "";
      showErrors([body.error ?? `Save failed (${response.status}).`, ...(body.details ?? [])]);
      return;
    }
    const index = launches.findIndex((l) => l.slug === checked.launch.slug);
    if (index >= 0) launches[index] = checked.launch;
    else launches.push(checked.launch);
    renderList();
    editing = checked.launch;
    saveStatus.textContent = "";
    const link = document.createElement("a");
    link.href = body.commitUrl;
    link.textContent = "commit";
    saveStatus.append(
      `Saved (`,
      link,
      `). The launch page appears after the site rebuilds (1–2 minutes). The NWS forecast follows within the hour; model meteograms start with the next model run (up to 6 hours).`,
    );
  } finally {
    save.disabled = false;
  }
});

$("new-launch").addEventListener("click", () => openForm(null));
// Old errors describe values that are being edited; clear them as soon as the form changes.
form.addEventListener("input", () => errors.replaceChildren());
$("cancel").addEventListener("click", () => {
  form.hidden = true;
  editing = null;
});

load();
