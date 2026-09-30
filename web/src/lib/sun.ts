// Sun position from the NOAA Global Monitoring Laboratory solar-calculator
// equations (after Meeus, Astronomical Algorithms). Accurate to about 0.01°
// between 1800 and 2100: far finer than the terrain grid the sun shines on.

const DEG = Math.PI / 180;

export interface SunPosition {
  /** Degrees clockwise from true north. */
  azimuthDeg: number;
  /** Apparent elevation above the horizon, with standard atmospheric refraction. */
  elevationDeg: number;
  /** Geometric elevation, without refraction. */
  trueElevationDeg: number;
  /** (mean earth-sun distance / current distance)²: scales the sunlight reaching the top of the atmosphere. */
  distanceFactor: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Standard refraction (degrees) for a geometric elevation, as in the NOAA calculator. */
export function refractionDeg(elevationDeg: number): number {
  if (elevationDeg > 85) return 0;
  const t = Math.tan(elevationDeg * DEG);
  let arcsec: number;
  if (elevationDeg > 5) arcsec = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
  else if (elevationDeg > -0.575) arcsec = 1735 + elevationDeg * (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)));
  else arcsec = -20.772 / t;
  return arcsec / 3600;
}

/** Where the sun is at an instant (ms since the epoch) seen from a point (degrees, east positive). */
export function sunPosition(ms: number, latDeg: number, lonDeg: number): SunPosition {
  const jd = ms / 86_400_000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const mr = m * DEG;
  const c = Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * mr) * (0.019993 - 0.000101 * t) + Math.sin(3 * mr) * 0.000289;
  const trueAnomaly = (m + c) * DEG;
  const radiusAu = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(trueAnomaly));
  const omega = (125.04 - 1934.136 * t) * DEG;
  const lambda = (l0 + c - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * DEG;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const l0r = l0 * DEG;
  const equationOfTimeMin =
    (4 / DEG) *
    (y * Math.sin(2 * l0r) - 2 * e * Math.sin(mr) + 4 * e * y * Math.sin(mr) * Math.cos(2 * l0r) - 0.5 * y * y * Math.sin(4 * l0r) - 1.25 * e * e * Math.sin(2 * mr));
  const trueSolarMin = mod(mod(ms / 60_000, 1440) + equationOfTimeMin + 4 * lonDeg, 1440);
  const hourAngle = (trueSolarMin / 4 - 180) * DEG;
  const lat = latDeg * DEG;
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)));
  const trueElevationDeg = 90 - Math.acos(cosZenith) / DEG;
  const azimuthDeg = mod(Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / DEG + 180, 360);
  return { azimuthDeg, elevationDeg: trueElevationDeg + refractionDeg(trueElevationDeg), trueElevationDeg, distanceFactor: 1 / (radiusAu * radiusAu) };
}

/** Unit vector toward the sun: x east, y north, z up. */
export function sunVector(position: SunPosition): [number, number, number] {
  const el = position.elevationDeg * DEG;
  const az = position.azimuthDeg * DEG;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}

/** Geometric elevation of the sun's centre at sunrise and sunset (refraction plus the sun's radius). */
const HORIZON_DEG = -0.833;

/**
 * Sunrise and sunset between two instants (usually a local midnight and the
 * next): the first upward and the last downward crossing of the horizon,
 * found to the second. Null when the sun does not cross it in that span.
 */
export function sunriseSunset(startMs: number, endMs: number, latDeg: number, lonDeg: number): { sunrise: number; sunset: number } | null {
  const above = (ms: number) => sunPosition(ms, latDeg, lonDeg).trueElevationDeg > HORIZON_DEG;
  const refine = (a: number, b: number, rising: boolean) => {
    while (b - a > 1000) {
      const mid = (a + b) / 2;
      if (above(mid) === rising) b = mid;
      else a = mid;
    }
    return Math.round((a + b) / 2);
  };
  const step = 10 * 60_000;
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let prev = above(startMs);
  for (let t = startMs + step; t <= endMs; t += step) {
    const now = above(t);
    if (now && !prev && sunrise === null) sunrise = refine(t - step, t, true);
    if (!now && prev) sunset = refine(t - step, t, false);
    prev = now;
  }
  return sunrise !== null && sunset !== null && sunset > sunrise ? { sunrise, sunset } : null;
}
