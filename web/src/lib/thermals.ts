// The Boise thermal forecast published by thermals/pipeline.py at
// /data/thermal_predictions.json (schema 2), and the helpers the /thermals
// page uses to read it.

export type DayKey = "today" | "yesterday";
export type ModelKey = "ensemble" | "lightgbm" | "xgboost";
export type Level = "low" | "medium" | "high";

export interface ThermalCell {
  id: number;
  lat: number;
  lon: number;
  elevation: number;
  slope: number;
  aspect: number;
  zone: string;
}

export interface ThermalHour {
  hour_local: number;
  valid_time_iso: string;
  local_time_display: string;
  is_daylight: boolean;
  sun_elevation_deg: number;
  hrrr?: { cycle_utc: string; fxx: number };
  weather_summary: {
    temp_c: number;
    dew_c: number;
    wind_speed_mph: number;
    wind_dir_deg: number;
    cape_jkg: number;
    blh_m: number;
    sensible_heat_wm2: number;
    net_radiation_wm2: number;
  };
  inputs_outside_training: string[];
  /** Probability per cell in thousandths, in the order of `cells`; null while the sun is down. */
  lightgbm: number[] | null;
  xgboost: number[] | null;
  /** Share of sunlight each cell absorbs, percent. */
  absorbed: number[];
}

export interface ThermalDay {
  date_iso: string;
  date_display: string;
  /** False when the day has no hours (out of season, if the pipeline skips those months). */
  supported: boolean;
  /** Whether the models saw this month in training (March to September). */
  in_training_season?: boolean;
  hours: ThermalHour[];
}

export interface ThermalPayload {
  schema: 2;
  metadata: {
    model_run: string | null;
    retrieved_at_utc: string;
    retrieved_at_local: string;
    thresholds: { low: number; high: number };
    grid_resolution_deg: number;
    season: { first_month: number; last_month: number };
    sample?: boolean;
  };
  cells: ThermalCell[];
  days: Record<DayKey, ThermalDay>;
}

const isArrayOf = (value: unknown, length: number) =>
  Array.isArray(value) && value.length === length && value.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000);

/** The payload, or null when it is not a schema-2 forecast with consistent arrays. */
export function parseThermalPayload(text: string): ThermalPayload | null {
  let data: ThermalPayload;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data?.schema !== 2 || !Array.isArray(data.cells) || !data.metadata || !data.days) return null;
  const n = data.cells.length;
  for (const key of ["today", "yesterday"] as const) {
    const day = data.days[key];
    if (!day || typeof day.supported !== "boolean" || !Array.isArray(day.hours)) return null;
    for (const hour of day.hours) {
      if (!isArrayOf(hour.absorbed, n)) return null;
      for (const model of [hour.lightgbm, hour.xgboost]) {
        if (model === null ? hour.is_daylight : !isArrayOf(model, n)) return null;
      }
    }
  }
  return data;
}

/** A cell's probability (0..1) for a model; the ensemble is the mean of the two. */
export function cellProbability(hour: ThermalHour, model: ModelKey, index: number): number | null {
  if (!hour.lightgbm || !hour.xgboost) return null;
  const value =
    model === "lightgbm" ? hour.lightgbm[index] : model === "xgboost" ? hour.xgboost[index] : (hour.lightgbm[index] + hour.xgboost[index]) / 2;
  return value / 1000;
}

export function levelFor(probability: number, low: number, high: number): Level {
  if (probability >= high) return "high";
  if (probability >= low) return "medium";
  return "low";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const monthName = (month: number) => MONTHS[month - 1] ?? String(month);

/** Plain names for the inputs an hour may list as outside the training range. */
export const INPUT_LABELS: Record<string, string> = {
  TOL_8000: "temperature difference to 8 km",
  TOL_1000: "temperature difference to 1 km",
  env_lapse_rate_4000: "dew point change to 4 km",
  env_lapse_rate_11000: "dew point change to 11 km",
  instability_1000: "low-level instability",
  instability_11000: "deep instability",
  dew_height_4000: "dew point change to 4 km",
  inversion_layer_1000: "low inversion",
  cape_sfc: "CAPE",
  cin_sfc: "CIN",
  lftx_sfc: "lifted index",
  blh_sfc: "boundary-layer height",
  ishf_sfc: "sensible heat flux",
  full_net_radiation: "net radiation",
  d2m_subh: "dew point",
  temperature_2500: "temperature at 2.5 km",
  temperature_8000: "temperature at 8 km",
  hour_of_day: "hour of day",
  month: "month",
};
