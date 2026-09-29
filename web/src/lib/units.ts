// Unit conversions and formatting shared by the charts and tables.

export const mph = (mps: number | null | undefined) => (mps == null ? null : mps * 2.23694);
export const ft = (m: number | null | undefined) => (m == null ? null : m * 3.28084);
export const fahrenheit = (c: number | null | undefined) => (c == null ? null : (c * 9) / 5 + 32);

export function fmt(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(value)) return "–";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** Rounds feet to the nearest 100 for display. */
export const ft100 = (m: number | null | undefined) => {
  const value = ft(m);
  return value == null ? null : Math.round(value / 100) * 100;
};

export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
