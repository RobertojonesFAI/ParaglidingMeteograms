import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { balloonSounding, choices, readChoice, srgSounding, type RaobDocument } from "../src/lib/balloon.ts";
import { parseSrg } from "../src/lib/srg.ts";

const TZ = "America/Boise";
const SRG = parseSrg(readFileSync(new URL("./fixtures/srg-boi.txt", import.meta.url), "utf8"));
const FT = 3.28084;

test("the morning table lifted from the forecast high tops out near the NWS thermal height", () => {
  const s = srgSounding(SRG.observed!, 874, SRG.forecastMaxTempC)!;
  // Standard-atmosphere estimate at the table's first row (3000 ft); the balloon measured 913 hPa at 2867 ft.
  assert.ok(Math.abs(s.points[0].pressureHpa - 908) < 8, `surface ${s.points[0].pressureHpa}`);
  const topFt = s.marks.zoneTopM! * FT;
  // NWS: 9,264 ft MSL. Same method (dry adiabat from the forecast high), our own interpolation.
  assert.ok(Math.abs(topFt - 9264) < 300, `${topFt}`);
  assert.equal(s.hasDewPoint, false);
  assert.equal(s.marks.cloudBaseM, null);
  assert.ok(s.inversions.some((l) => l.grounded), "the valley inversion at dawn");
});

test("without a balloon file, the Soaring Forecast's own table and model hours are offered", () => {
  const list = choices(null, SRG, TZ);
  assert.deepEqual(list.map((c) => `${c.kind} ${c.validAt}`), [
    "balloon 2026-09-29T12:00:00Z",
    "model 2026-09-29T15:00:00Z",
    "model 2026-09-29T18:00:00Z",
    "model 2026-09-29T21:00:00Z",
    "model 2026-09-30T00:00:00Z",
  ]);
  assert.equal(list[0].start.source, "forecast-high");
  assert.equal(list[0].start.temperatureC, 24.9);
  assert.equal(list[1].start.source, "observed");
});

test("the morning reading uses the NWS numbers and says it plainly", () => {
  const [morning] = choices(null, SRG, TZ);
  const r = readChoice(morning, SRG, 1268, TZ);
  assert.match(r.headline, /^If it reaches 77 °F: thermals to about 9,[3-5]00 ft\.$/);
  const title = (t: string) => r.findings.find((f) => f.title === t)!;
  assert.match(title("Thermals: Fair").text, /forecast high of 77 °F.*The NWS puts it at 9,264 ft, with lift up to 382 ft\/min\./);
  assert.equal(title("When they start").text, "Usable thermals start once it reaches 70 °F, around 1:30 PM (NWS).");
  assert.match(title("Your launch").text, /From your launch at 4,200 ft, that is about 5,[1-3]00 ft of climb\./);
  assert.equal(title("Storms").text, "Lifted index +8.1: very stable aloft: no storm risk.");
  assert.equal(title("Clouds").text, "This table has no humidity, so it cannot show clouds.");
  assert.ok(r.findings.some((f) => f.title === "Valley inversion"));
});

test("a model hour reads as that hour's thermals", () => {
  const list = choices(null, SRG, TZ);
  const three = list.find((c) => c.validAt === "2026-09-29T21:00:00Z")!;
  const r = readChoice(three, SRG, 1268, TZ);
  assert.match(r.headline, /^Thermals to about [\d,]+ ft at 3:00 PM\.$/);
  assert.match(r.findings[0].text, /At 3:00 PM the NWS model has thermals from 72 °F at the ground/);
  assert.match(r.findings.find((f) => f.key === "storms")!.text, /Lifted index \+6\.2/);
});

test("a real balloon file comes first and shows clouds from its dew point", () => {
  const levels = [
    [913, 874, 12, 2], [900, 990, 14, 1], [850, 1480, 12, -1], [800, 1990, 8, -2], [750, 2520, 3.5, -3],
    [700, 3080, -1, -4], [650, 3660, -5.5, -6.5], [600, 4270, -10, -11], [550, 4910, -15, -19], [500, 5600, -20, -28], [400, 7200, -33, -45],
  ].map(([p, z, t, td]) => ({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td, windDirectionDeg: 320, windSpeedMps: 6 }));
  const doc: RaobDocument = {
    schemaVersion: 1,
    generatedAt: "2026-09-29T13:30:00Z",
    station: { id: "KBOI", name: "Boise", latitude: 43.57, longitude: -116.21, distanceKm: 20, elevationM: 874 },
    soundings: [{ validAt: "2026-09-29T12:00:00Z", levels }],
  };
  const list = choices(doc, SRG, TZ);
  assert.equal(list[0].kind, "balloon");
  assert.equal(list[0].hasDewPoint, true);
  assert.equal(list[0].srgProfile, SRG.observed);
  assert.equal(list.filter((c) => c.kind === "balloon").length, 1, "the table is not repeated when the balloon file has that flight");
  const r = readChoice(list[0], SRG, 1268, TZ);
  assert.match(r.findings.find((f) => f.key === "clouds")!.text, /^(Thermals reach condensation|Blue)/);
  assert.ok(balloonSounding(doc.soundings[0], null)!.points.every((p) => p.pressureHpa >= 450));
});

test("a flight the archive missed comes from the Soaring Forecast's table, in time order", () => {
  const evening = [[913, 874, 23.8, -0.2], [850, 1500, 18, -3], [800, 2010, 13.5, -5], [750, 2540, 9, -7], [700, 3100, 4, -9], [600, 4300, -5, -15], [500, 5700, -16, -25]]
    .map(([p, z, t, td]) => ({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td, windDirectionDeg: 300, windSpeedMps: 5 }));
  const doc: RaobDocument = {
    schemaVersion: 1,
    generatedAt: "2026-09-30T05:00:00Z",
    station: { id: "KBOI", name: "Boise", latitude: 43.57, longitude: -116.21, distanceKm: 20, elevationM: 874 },
    soundings: [{ validAt: "2026-09-30T00:00:00Z", levels: evening }],
  };
  const balloons = choices(doc, SRG, TZ).filter((c) => c.kind === "balloon");
  assert.deepEqual(balloons.map((c) => [c.validAt, c.hasDewPoint]), [["2026-09-30T00:00:00Z", true], ["2026-09-29T12:00:00Z", false]]);
  assert.equal(balloons[1].start.source, "forecast-high");
});
