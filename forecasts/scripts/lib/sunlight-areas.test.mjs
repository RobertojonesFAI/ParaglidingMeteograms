import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { areaErrors, areaSizeKm, parseAreas } from "./sunlight-areas.mjs";

const sites = [{ slug: "king-mountain", latitude: 43.76382, longitude: -113.29149 }];
const lostRiver = { name: "Lost River Range", south: 43.58, west: -114.35, north: 44.6, east: -113.05 };
const doc = (areas) => ({ schemaVersion: 1, areas });

test("the Lost River Range area is valid for King Mountain", () => {
  assert.deepEqual(areaErrors(doc({ "king-mountain": lostRiver }), sites), []);
  const size = areaSizeKm(lostRiver);
  assert.ok(size.eastWest > 100 && size.eastWest < 110 && size.northSouth > 110 && size.northSouth < 116);
  assert.deepEqual(parseAreas(doc({ "king-mountain": lostRiver }))["king-mountain"], lostRiver);
});

test("areas must belong to a launch, contain it, and stay buildable", () => {
  assert.match(areaErrors(doc({ nowhere: lostRiver }), sites)[0], /not in sites.json/);
  assert.match(areaErrors(doc({ "king-mountain": { ...lostRiver, east: -113.5 } }), sites)[0], /outside its sunlight area/);
  assert.match(areaErrors(doc({ "king-mountain": { ...lostRiver, west: -116 } }), sites)[0], /at most 160 km/);
  assert.match(areaErrors(doc({ "king-mountain": { ...lostRiver, radiusKm: 3 } }), sites)[0], /exactly name, south/);
  assert.match(areaErrors(doc({ "king-mountain": { ...lostRiver, name: " " } }), sites)[0], /needs a name/);
  assert.match(areaErrors({ areas: {} }, sites)[0], /schemaVersion/);
});

test("the committed sunlight-areas.json only lists launches of sites.json", () => {
  const committed = JSON.parse(readFileSync(new URL("../../sunlight-areas.json", import.meta.url), "utf8"));
  const catalogue = JSON.parse(readFileSync(new URL("../../sites.json", import.meta.url), "utf8")).sites;
  assert.deepEqual(areaErrors(committed, catalogue), []);
});
