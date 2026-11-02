// Which forecasts cover which launches.
//
// The engine samples every launch in the site catalogue it is given, and a
// launch outside a model's grid makes the whole build of that model fail
// ("outside the model grid"), for every launch. So each model is built only
// for the launches it covers (scripts/model-sites.mjs writes that catalogue),
// and the NWS run skips launches outside the United States.
//
// Pure functions, no I/O: the forecast scripts, the Worker and the website
// all import this file.

const DEG = Math.PI / 180;

/**
 * NOAA's 3 km CONUS grid: HRRR, and the CONUS output of RRFS and the NAM nest.
 * Lambert conformal, tangent at 38.5°N, centred on 97.5°W, 1799 x 1059 points
 * every 3 km from the south-west corner (21.138123°N, 122.719528°W), on a
 * sphere of radius 6,371,229 m (GRIB2 shape of the earth 6).
 */
export const CONUS_3KM = {
  standardParallel: 38.5,
  centralMeridian: -97.5,
  firstLatitude: 21.138123,
  firstLongitude: -122.719528,
  nx: 1799,
  ny: 1059,
  spacingM: 3000,
  radiusM: 6_371_229,
};

/** Fractional grid indices (i east, j north) of a point on a tangent Lambert conformal grid. */
export function lambertIndices(grid, latitude, longitude) {
  const n = Math.sin(grid.standardParallel * DEG);
  const f = (Math.cos(grid.standardParallel * DEG) * Math.tan(Math.PI / 4 + (grid.standardParallel * DEG) / 2) ** n) / n;
  const project = (lat, lon) => {
    const rho = (grid.radiusM * f) / Math.tan(Math.PI / 4 + (lat * DEG) / 2) ** n;
    let dLon = lon - grid.centralMeridian;
    dLon = ((((dLon + 180) % 360) + 360) % 360) - 180;
    const theta = n * dLon * DEG;
    return { x: rho * Math.sin(theta), y: -rho * Math.cos(theta) };
  };
  const origin = project(grid.firstLatitude, grid.firstLongitude);
  const point = project(latitude, longitude);
  return { i: (point.x - origin.x) / grid.spacingM, j: (point.y - origin.y) / grid.spacingM };
}

/** Inside the grid with `marginPoints` to spare on every side. */
export function inLambertGrid(grid, latitude, longitude, marginPoints = 5) {
  const { i, j } = lambertIndices(grid, latitude, longitude);
  return i >= marginPoints && i <= grid.nx - 1 - marginPoints && j >= marginPoints && j <= grid.ny - 1 - marginPoints;
}

const box = (south, north, west, east) => (lat, lon) => lat >= south && lat <= north && lon >= west && lon <= east;

/**
 * ECCC's regional models (HRDPS, RDPS) are rotated latitude-longitude grids
 * over Canada and the United States whose exact southern edge is not modelled
 * here. Only launches north of 30°N are sent to them: the grids reach further
 * south, but a launch past the edge would fail the whole run.
 */
const ecccRegional = box(30, 75, -170, -50);

/** How each model's coverage is decided; models not listed are global. */
const MODEL_COVERAGE = {
  "hrrr-conus": (lat, lon) => inLambertGrid(CONUS_3KM, lat, lon),
  rrfs: (lat, lon) => inLambertGrid(CONUS_3KM, lat, lon),
  "nam-conus-nest": (lat, lon) => inLambertGrid(CONUS_3KM, lat, lon),
  "hrdps-continental": ecccRegional,
  "hrdps-west": box(30, 60, -140, -110),
  rdps: ecccRegional,
};

/** True when `model` covers the launch (unknown models count as global). */
export function modelCovers(model, site) {
  const covers = MODEL_COVERAGE[model];
  return covers ? covers(site.latitude, site.longitude) : true;
}

/** Splits `sites` into the launches a model covers and the ones it does not. */
export function sitesForModel(model, sites) {
  const covered = [];
  const skipped = [];
  for (const site of sites) (modelCovers(model, site) ? covered : skipped).push(site);
  return { covered, skipped };
}

// The National Weather Service forecasts the United States: the lower 48,
// Alaska, Hawaii and Puerto Rico (and the US Virgin Islands).
const NWS_AREAS = [
  box(24, 49.5, -125, -66.5),
  box(51, 72, -180, -129),
  box(18.5, 22.5, -161, -154),
  box(17.5, 18.8, -68, -64.5),
];

/** True when the National Weather Service has a forecast for the point. */
export function nwsCovers(latitude, longitude) {
  return NWS_AREAS.some((area) => area(latitude, longitude));
}
