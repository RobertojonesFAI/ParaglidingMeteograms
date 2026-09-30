// Reads the NWS Soaring Forecast (product SRG) text: the headline soaring
// numbers, the morning balloon table and the model forecast tables.
//
// The format is the one the Boise office issues twice a day (other offices
// using the same soaring program print the same layout). Anything the parser
// does not find comes back null, so a format change degrades the chart
// rather than breaking the page.

export interface SrgRow {
  heightFt: number;
  temperatureC: number;
  windDirectionDeg: number | null;
  windSpeedKt: number | null;
  lapseCPerKm: number | null;
  /** Surface temperature a thermal needs to reach this height (observed table only). */
  convectionTempC: number | null;
  thermalIndex: number | null;
  liftFpm: number | null;
}

export interface SrgProfile {
  kind: "observed" | "model";
  validAt: string;
  rows: SrgRow[];
  capeJkg: number | null;
  cinJkg: number | null;
  liftedIndex: number | null;
  kIndex: number | null;
  freezingLevelFt: number | null;
  lclFt: number | null;
  cclFt: number | null;
}

export interface Srg {
  /** Local date the forecast is for, YYYY-MM-DD. */
  forecastDate: string | null;
  triggerTempC: number | null;
  soaringIndex: string | null;
  maxLiftFpm: number | null;
  maxThermalHeightFt: number | null;
  forecastMaxTempC: number | null;
  triggerTime: string | null;
  overdevelopment: string | null;
  midHighClouds: string | null;
  surfaceWinds: string | null;
  minus3IndexHeightFt: number | null;
  outlook: { day: string; index: string } | null;
  stationElevationFt: number | null;
  observed: SrgProfile | null;
  model: SrgProfile[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const value = (text: string, pattern: RegExp) => pattern.exec(text)?.[1]?.trim() ?? null;
const number = (s: string | null | undefined) => {
  if (s == null || s === "M") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** "09/29/2026", "0600", "MDT" → ISO instant. */
export function srgInstant(date: string, hhmm: string, zone: string): string | null {
  const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(date);
  if (!m || !/^\d{4}$/.test(hhmm)) return null;
  const offset = zone === "MDT" ? 6 : zone === "MST" ? 7 : zone === "PDT" ? 7 : zone === "PST" ? 8 : zone === "CDT" ? 5 : zone === "CST" ? 6 : null;
  if (offset === null) return null;
  const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(hhmm.slice(0, 2)) + offset, Number(hhmm.slice(2)));
  return new Date(t).toISOString().replace(".000Z", "Z");
}

/** Drops rows whose values repeat the row below: the table fills gaps by repeating. */
function dedupe(rows: SrgRow[]): SrgRow[] {
  const sorted = [...rows].sort((a, b) => a.heightFt - b.heightFt);
  const out: SrgRow[] = [];
  for (const row of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.temperatureC === row.temperatureC && prev.windSpeedKt === row.windSpeedKt && prev.windDirectionDeg === row.windDirectionDeg) continue;
    out.push(row);
  }
  return out;
}

function tableRows(lines: string[], start: number): { rows: string[]; end: number } {
  let i = start;
  while (i < lines.length && !/^-{20,}/.test(lines[i].trim())) i += 1;
  const rows: string[] = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^_{10,}/.test(line.trim()) || /^\s*\*/.test(line)) break;
    rows.push(line);
  }
  return { rows, end: i };
}

function observedTable(text: string, lines: string[]): SrgProfile | null {
  const header = /Upper air data from rawinsonde observation taken on (\d\d\/\d\d\/\d{4}) at (\d{4}) (\w{3})/.exec(text);
  if (!header) return null;
  const validAt = srgInstant(header[1], header[2], header[3]);
  const start = lines.findIndex((l) => l.includes("Upper air data from rawinsonde"));
  if (!validAt || start < 0) return null;
  const { rows } = tableRows(lines, start);
  const parsed: SrgRow[] = [];
  for (const line of rows) {
    const t = line.trim().split(/\s+/);
    if (t.length < 13) continue;
    const temperatureC = number(t[1]);
    const heightFt = number(t[0]);
    if (temperatureC === null || heightFt === null) continue;
    parsed.push({
      heightFt,
      temperatureC,
      windDirectionDeg: number(t[3]),
      windSpeedKt: number(t[4]),
      lapseCPerKm: number(t[6]),
      convectionTempC: number(t[8]),
      thermalIndex: number(t[10]),
      liftFpm: number(t[11]),
    });
  }
  const ft = (label: string) => number(value(text, new RegExp(`${label}\\.+\\s*(-?\\d+) ft MSL`)));
  return {
    kind: "observed",
    validAt,
    rows: dedupe(parsed),
    capeJkg: null,
    cinJkg: null,
    liftedIndex: number(value(text, /Lifted index\.+\s*([+-]?[\d.]+)/)),
    kIndex: number(value(text, /K index\.+\s*([+-]?[\d.]+)/)),
    freezingLevelFt: ft("Freezing level"),
    lclFt: ft("Lifted condensation level"),
    cclFt: ft("Convective condensation level"),
  };
}

function modelTables(lines: string[]): SrgProfile[] {
  const out: SrgProfile[] = [];
  const headerRe = /^\s*(\d\d\/\d\d\/\d{4}) at (\d{4}) (\w{3})\s*\|\s*(\d\d\/\d\d\/\d{4}) at (\d{4}) (\w{3})/;
  for (let i = 0; i < lines.length; i += 1) {
    const h = headerRe.exec(lines[i]);
    if (!h) continue;
    const times = [srgInstant(h[1], h[2], h[3]), srgInstant(h[4], h[5], h[6])];
    const indices = [0, 1].map(() => ({ cape: null as number | null, cin: null as number | null, li: null as number | null, k: null as number | null }));
    let j = i + 1;
    for (; j < lines.length && !/^-{20,}/.test(lines[j].trim()); j += 1) {
      const halves = lines[j].split("|");
      halves.forEach((half, side) => {
        if (side > 1) return;
        const cape = /CAPE\.+\s*(-?[\d.]+)/.exec(half);
        const li = /LI\.+\s*([+-]?[\d.]+)/.exec(half);
        const cin = /CINH\.+\s*(-?[\d.]+)/.exec(half);
        const k = /K Index\.+\s*([+-]?[\d.]+)/.exec(half);
        if (cape) indices[side].cape = Number(cape[1]);
        if (li) indices[side].li = Number(li[1]);
        if (cin) indices[side].cin = Number(cin[1]);
        if (k) indices[side].k = Number(k[1]);
      });
    }
    const { rows, end } = tableRows(lines, j);
    const sides: SrgRow[][] = [[], []];
    for (const line of rows) {
      const [left, right] = line.split("|");
      const l = left?.trim().split(/\s+/) ?? [];
      const r = right?.trim().split(/\s+/) ?? [];
      const heightFt = number(l[0]);
      if (heightFt === null) continue;
      const row = (t: string[], o: number): SrgRow | null => {
        const temperatureC = number(t[o]);
        if (temperatureC === null) return null;
        return { heightFt, temperatureC, windDirectionDeg: number(t[o + 2]), windSpeedKt: number(t[o + 3]), lapseCPerKm: number(t[o + 5]), convectionTempC: null, thermalIndex: null, liftFpm: null };
      };
      const a = row(l, 1);
      const b = row(r, 0);
      if (a) sides[0].push(a);
      if (b) sides[1].push(b);
    }
    [0, 1].forEach((side) => {
      const validAt = times[side];
      if (!validAt || sides[side].length < 5) return;
      out.push({
        kind: "model",
        validAt,
        rows: dedupe(sides[side]),
        capeJkg: indices[side].cape,
        cinJkg: indices[side].cin,
        liftedIndex: indices[side].li,
        kIndex: indices[side].k,
        freezingLevelFt: null,
        lclFt: null,
        cclFt: null,
      });
    });
    i = end;
  }
  return out;
}

export function parseSrg(text: string): Srg {
  const lines = text.split(/\r?\n/);
  const dateMatch = /This forecast is for \w+, (\w+) (\d+), (\d{4})/.exec(text);
  const month = dateMatch ? MONTHS.indexOf(dateMatch[1].toLowerCase()) + 1 : 0;
  const forecastDate = dateMatch && month > 0 ? `${dateMatch[3]}-${String(month).padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}` : null;
  const trigger = /trigger temperature of ([\d.]+) F\/(-?[\d.]+) C/.exec(text);
  const maxTemp = /Forecast maximum temperature\.+\s*([\d.]+) F\/(-?[\d.]+) C/.exec(text);
  const triggerAt = /Time of trigger temperature\.+\s*(\d{4}) (\w{3})/.exec(text);
  const outlook = /Thermal soaring outlook for (\w+ [\d/]+)\.+\s*(.+)$/m.exec(text);
  const elevation = /Elevation:\s*(\d+) feet/.exec(text);
  const us = forecastDate ? `${forecastDate.slice(5, 7)}/${forecastDate.slice(8, 10)}/${forecastDate.slice(0, 4)}` : null;
  return {
    forecastDate,
    triggerTempC: trigger ? Number(trigger[2]) : null,
    soaringIndex: value(text, /Thermal Soaring Index\.+\s*(.+)$/m),
    maxLiftFpm: number(value(text, /Maximum rate of lift\.+\s*(\d+) ft\/min/)),
    maxThermalHeightFt: number(value(text, /Maximum height of thermals\.+\s*(\d+) ft MSL/)),
    forecastMaxTempC: maxTemp ? Number(maxTemp[2]) : null,
    triggerTime: triggerAt && us ? srgInstant(us, triggerAt[1], triggerAt[2]) : null,
    overdevelopment: value(text, /Time of overdevelopment\.+\s*(.+)$/m),
    midHighClouds: value(text, /Middle\/high clouds during soaring window\.+\s*(.+)$/m),
    surfaceWinds: value(text, /Surface winds during soaring window\.+\s*(.+)$/m),
    minus3IndexHeightFt: number(value(text, /Height of the -3 thermal index\.+\s*(\d+) ft MSL/)),
    outlook: outlook ? { day: outlook[1], index: outlook[2].trim() } : null,
    stationElevationFt: elevation ? Number(elevation[1]) : null,
    observed: observedTable(text, lines),
    model: modelTables(lines),
  };
}
