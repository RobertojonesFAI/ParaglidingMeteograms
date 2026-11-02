import { test } from "node:test";
import assert from "node:assert/strict";
import { CONUS_3KM, lambertIndices, modelCovers, nwsCovers, sitesForModel } from "./coverage.mjs";

const site = (slug, latitude, longitude) => ({ slug, name: slug, latitude, longitude, timeZone: "UTC" });
const CERVIDAE = site("cervidae-peak", 43.62332, -115.98076);
const KING = site("king-mountain", 43.76382, -113.29149);
const PENON = site("el-penon", 19.06224, -100.09016);
const TORRE = site("la-torre", 19.18436, -100.11303);

test("the CONUS 3 km grid matches HRRR's published corners", () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1.5, `${actual} vs ${expected}`);
  const sw = lambertIndices(CONUS_3KM, 21.138123, -122.719528);
  near(sw.i, 0);
  near(sw.j, 0);
  const se = lambertIndices(CONUS_3KM, 21.140748, -72.288247);
  near(se.i, 1798);
  near(se.j, 0);
  const nw = lambertIndices(CONUS_3KM, 47.838623, -134.09548);
  near(nw.i, 0);
  near(nw.j, 1058);
});

test("Idaho launches get every model; Valle de Bravo only the global ones", () => {
  for (const model of ["hrrr-conus", "rrfs", "hrdps-continental", "rdps", "gfs", "gdps", "geps"]) {
    assert.equal(modelCovers(model, CERVIDAE), true, model);
    assert.equal(modelCovers(model, KING), true, model);
  }
  for (const model of ["hrrr-conus", "rrfs", "hrdps-continental", "rdps"]) assert.equal(modelCovers(model, PENON), false, model);
  for (const model of ["gfs", "gdps", "geps", "some-new-global-model"]) assert.equal(modelCovers(model, TORRE), true, model);
});

test("a model's catalogue keeps the launches it covers, in order", () => {
  const { covered, skipped } = sitesForModel("hrrr-conus", [CERVIDAE, PENON, KING, TORRE]);
  assert.deepEqual(covered.map((s) => s.slug), ["cervidae-peak", "king-mountain"]);
  assert.deepEqual(skipped.map((s) => s.slug), ["el-penon", "la-torre"]);
  assert.equal(sitesForModel("gfs", [CERVIDAE, PENON]).covered.length, 2);
});

test("the NWS covers the US, not Mexico or Europe", () => {
  assert.equal(nwsCovers(CERVIDAE.latitude, CERVIDAE.longitude), true);
  assert.equal(nwsCovers(61.2, -149.9), true); // Anchorage
  assert.equal(nwsCovers(21.3, -157.8), true); // Honolulu
  assert.equal(nwsCovers(PENON.latitude, PENON.longitude), false);
  assert.equal(nwsCovers(46.5, 7.9), false);
});
