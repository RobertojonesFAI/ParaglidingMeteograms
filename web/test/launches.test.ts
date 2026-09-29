import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLaunch,
  compassPoint,
  consistencyErrors,
  inArc,
  joinLaunches,
  slugify,
  validateLaunchInput,
  windWindow,
  type LaunchesFile,
  type SitesFile,
} from "../src/lib/launches.ts";

const sites: SitesFile = {
  schemaVersion: 2,
  sites: [{ slug: "cervidae-peak", name: "Cervidae Peak", latitude: 43.62332, longitude: -115.98076, timeZone: "America/Boise" }],
};
const launches: LaunchesFile = {
  schemaVersion: 1,
  launches: {
    "cervidae-peak": { facingDeg: 315, windArcHalfWidthDeg: 45, windMinMph: 5, windMaxMph: 15, gustMaxMph: 20, region: "Boise, ID", notes: "" },
  },
};

const input = {
  name: "  Shafer   Butte ",
  latitude: "43.78",
  longitude: "-116.08",
  timeZone: "America/Boise",
  facingDeg: "202.5",
  windArcHalfWidthDeg: "45",
  windMinMph: "4",
  windMaxMph: "14",
  gustMaxMph: "18",
  region: "Boise, ID",
  notes: "Road closes in winter.",
};

test("wind window is centred on the launch direction and wraps through north", () => {
  assert.deepEqual(windWindow({ facingDeg: 315, windArcHalfWidthDeg: 45 }), { fromDeg: 270, toDeg: 0 });
  const nw = windWindow({ facingDeg: 315, windArcHalfWidthDeg: 45 });
  assert.equal(inArc(300, nw), true);
  assert.equal(inArc(0, nw), true);
  assert.equal(inArc(359.9, nw), true);
  assert.equal(inArc(10, nw), false);
  assert.equal(inArc(180, nw), false);
  assert.deepEqual(windWindow({ facingDeg: 180, windArcHalfWidthDeg: 30 }), { fromDeg: 150, toDeg: 210 });
});

test("compass points and slugs", () => {
  assert.equal(compassPoint(315), "NW");
  assert.equal(compassPoint(359), "N");
  assert.equal(compassPoint(202.5), "SSW");
  assert.equal(slugify("  Cervidae Peak  "), "cervidae-peak");
  assert.equal(slugify("Señal Álta #2"), "senal-alta-2");
});

test("validateLaunchInput normalizes a good submission", () => {
  const result = validateLaunchInput(input);
  assert.ok("launch" in result);
  assert.deepEqual(result.launch, {
    slug: "shafer-butte",
    name: "Shafer Butte",
    latitude: 43.78,
    longitude: -116.08,
    timeZone: "America/Boise",
    facingDeg: 203,
    windArcHalfWidthDeg: 45,
    windMinMph: 4,
    windMaxMph: 14,
    gustMaxMph: 18,
    region: "Boise, ID",
    notes: "Road closes in winter.",
  });
});

test("validateLaunchInput reports every problem", () => {
  const result = validateLaunchInput({ ...input, name: "X", latitude: "91", timeZone: "Mars/Olympus", facingDeg: "", windMinMph: "20", windMaxMph: "10", gustMaxMph: "5" });
  assert.ok("errors" in result);
  assert.equal(result.errors.length, 6);
});

test("validateLaunchInput asks for a map pick when coordinates are missing", () => {
  const result = validateLaunchInput({ ...input, latitude: "", longitude: "" });
  assert.ok("errors" in result);
  assert.deepEqual(result.errors, ["Place the launch on the map, or type its latitude and longitude."]);
});

test("applyLaunch creates, updates, and refuses duplicates and unknown slugs", () => {
  const created = applyLaunch(sites, launches, { ...(validateLaunchInput(input) as { launch: never }).launch }, "create");
  assert.ok(!("error" in created));
  assert.equal(created.sites.sites.length, 2);
  assert.deepEqual(consistencyErrors(created.sites, created.launches), []);
  assert.equal(joinLaunches(created.sites, created.launches)[1].facingDeg, 203);

  const cervidae = joinLaunches(sites, launches)[0];
  const updated = applyLaunch(sites, launches, { ...cervidae, windMaxMph: 12 }, "update");
  assert.ok(!("error" in updated));
  assert.equal(updated.launches.launches["cervidae-peak"].windMaxMph, 12);
  assert.equal(updated.sites.sites.length, 1);

  assert.match((applyLaunch(sites, launches, cervidae, "create") as { error: string }).error, /already exists/);
  assert.match((applyLaunch(sites, launches, { ...cervidae, slug: "nope" }, "update") as { error: string }).error, /No launch/);
});

test("consistencyErrors finds orphans on either side", () => {
  const orphan: LaunchesFile = { schemaVersion: 1, launches: { ...launches.launches, extra: launches.launches["cervidae-peak"] } };
  assert.deepEqual(consistencyErrors(sites, orphan), ["extra: in launches.json but not in sites.json"]);
  assert.deepEqual(consistencyErrors(sites, { schemaVersion: 1, launches: {} }), ["cervidae-peak: missing from launches.json"]);
});
