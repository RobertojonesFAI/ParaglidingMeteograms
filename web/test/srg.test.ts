import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSrg, srgInstant } from "../src/lib/srg.ts";

const TEXT = readFileSync(new URL("./fixtures/srg-boi.txt", import.meta.url), "utf8");

test("the headline soaring numbers", () => {
  const s = parseSrg(TEXT);
  assert.equal(s.forecastDate, "2026-09-29");
  assert.equal(s.triggerTempC, 20.9);
  assert.equal(s.soaringIndex, "Fair");
  assert.equal(s.maxLiftFpm, 382);
  assert.equal(s.maxThermalHeightFt, 9264);
  assert.equal(s.forecastMaxTempC, 24.9);
  assert.equal(s.triggerTime, "2026-09-29T19:30:00Z");
  assert.equal(s.overdevelopment, "None");
  assert.equal(s.midHighClouds, "None");
  assert.equal(s.surfaceWinds, "20 mph or less");
  assert.equal(s.minus3IndexHeightFt, 7292);
  assert.deepEqual(s.outlook, { day: "Wednesday 09/30", index: "Fair" });
  assert.equal(s.stationElevationFt, 2867);
});

test("the morning balloon table", () => {
  const o = parseSrg(TEXT).observed!;
  assert.equal(o.validAt, "2026-09-29T12:00:00Z");
  assert.equal(o.liftedIndex, 8.1);
  assert.equal(o.kIndex, 2.1);
  assert.equal(o.freezingLevelFt, 13738);
  assert.equal(o.lclFt, 13662);
  assert.equal(o.cclFt, 19096);
  // 2900 ft is below ground (M); repeated rows (3100-3300, 3400-3500) collapse to their lowest.
  assert.deepEqual(o.rows.slice(0, 4).map((r) => r.heightFt), [3000, 3100, 3400, 3750]);
  assert.deepEqual(o.rows[0], { heightFt: 3000, temperatureC: 8.5, windDirectionDeg: 345, windSpeedKt: 2, lapseCPerKm: -34.4, convectionTempC: 9.2, thermalIndex: -15.9, liftFpm: 121 });
  const r9000 = o.rows.find((r) => r.heightFt === 9000)!;
  assert.equal(r9000.thermalIndex, -0.2);
  assert.equal(r9000.liftFpm, 371);
  const r10000 = o.rows.find((r) => r.heightFt === 10000)!;
  assert.equal(r10000.liftFpm, null);
  assert.equal(o.rows.at(-1)!.heightFt, 40000);
});

test("the four model forecast hours", () => {
  const m = parseSrg(TEXT).model;
  assert.deepEqual(m.map((p) => p.validAt), ["2026-09-29T15:00:00Z", "2026-09-29T18:00:00Z", "2026-09-29T21:00:00Z", "2026-09-30T00:00:00Z"]);
  assert.deepEqual(m.map((p) => p.liftedIndex), [10.9, 7.9, 6.2, 5.1]);
  assert.deepEqual(m.map((p) => p.kIndex), [3.4, 6.8, 14.3, 15.1]);
  assert.deepEqual(m.map((p) => p.cinJkg), [-0.2, 0, -0.2, -0.1]);
  assert.equal(m[2].rows[0].temperatureC, 22.0);
  assert.equal(m[2].rows[0].windDirectionDeg, 310);
  assert.equal(m[3].rows.find((r) => r.heightFt === 12000)!.temperatureC, 3.0);
  assert.equal(m[1].rows.find((r) => r.heightFt === 4500)!.lapseCPerKm, 7.9);
});

test("times convert from the office's local zone; a changed format gives nulls, not errors", () => {
  assert.equal(srgInstant("01/15/2027", "0600", "MST"), "2027-01-15T13:00:00Z");
  assert.equal(srgInstant("01/15/2027", "0600", "XYZ"), null);
  const empty = parseSrg("Soaring Forecast\nnothing here");
  assert.equal(empty.observed, null);
  assert.deepEqual(empty.model, []);
  assert.equal(empty.maxThermalHeightFt, null);
});
