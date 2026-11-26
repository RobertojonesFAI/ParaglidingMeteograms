// The area the Boise thermal map covers, from the same terrain grid the
// forecast pipeline uses (thermals/data/boise_terrain_grid.json). Imported
// only by .astro pages, at build time.

import grid from "../../../thermals/data/boise_terrain_grid.json";

const HALF_CELL_DEG = 0.015 / 2;
const cells = grid as Array<{ lat: number; lon: number }>;

export const THERMAL_DOMAIN = {
  south: Math.min(...cells.map((c) => c.lat)) - HALF_CELL_DEG,
  north: Math.max(...cells.map((c) => c.lat)) + HALF_CELL_DEG,
  west: Math.min(...cells.map((c) => c.lon)) - HALF_CELL_DEG,
  east: Math.max(...cells.map((c) => c.lon)) + HALF_CELL_DEG,
};

export function inThermalDomain(latitude: number, longitude: number): boolean {
  const d = THERMAL_DOMAIN;
  return latitude >= d.south && latitude <= d.north && longitude >= d.west && longitude <= d.east;
}
