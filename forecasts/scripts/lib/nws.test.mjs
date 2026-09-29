import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API,
  buildSiteDocument,
  convert,
  createClient,
  describeWeather,
  expandLayer,
  fetchOfficeDocument,
  fetchSiteDocument,
  parseDuration,
  parseValidTime,
} from "./nws.mjs";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-29T18:30:00Z");

const site = {
  slug: "cervidae-peak",
  name: "Cervidae Peak",
  latitude: 43.62332,
  longitude: -115.98076,
  timeZone: "America/Boise",
};

// Shapes follow api.weather.gov: /points, /gridpoints (raw layers with
// ISO 8601 validTime intervals), /forecast/hourly and /forecast periods.
const point = {
  properties: {
    gridId: "BOI",
    gridX: 142,
    gridY: 88,
    forecast: `${API}/gridpoints/BOI/142,88/forecast`,
    forecastHourly: `${API}/gridpoints/BOI/142,88/forecast/hourly`,
    forecastGridData: `${API}/gridpoints/BOI/142,88`,
  },
};

function makeGrid(overrides = {}) {
  return {
    properties: {
      updateTime: "2026-09-29T17:42:11+00:00",
      elevation: { unitCode: "wmoUnit:m", value: 1463.04 },
      temperature: {
        uom: "wmoUnit:degC",
        values: [
          { validTime: "2026-09-29T17:00:00+00:00/PT3H", value: 21.111 },
          { validTime: "2026-09-29T20:00:00+00:00/PT1H", value: 22.222 },
          { validTime: "2026-09-29T21:00:00+00:00/P1DT3H", value: 15 },
        ],
      },
      dewpoint: { uom: "wmoUnit:degC", values: [{ validTime: "2026-09-29T18:00:00+00:00/P2D", value: -1.667 }] },
      windSpeed: { uom: "wmoUnit:km_h-1", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT6H", value: 18.52 }] },
      windGust: { uom: "wmoUnit:km_h-1", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT3H", value: 27.78 }] },
      windDirection: { uom: "wmoUnit:degree_(angle)", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT12H", value: 200 }] },
      mixingHeight: { uom: "wmoUnit:m", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT4H", value: 2926.08 }] },
      transportWindSpeed: { uom: "wmoUnit:km_h-1", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT4H", value: 25.928 }] },
      transportWindDirection: { uom: "wmoUnit:degree_(angle)", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT4H", value: 230 }] },
      skyCover: { uom: "wmoUnit:percent", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT1H", value: 12 }] },
      lightningActivityLevel: { uom: "nwsUnit:n/a", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT6H", value: 2 }] },
      ceilingHeight: { uom: "wmoUnit:m", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT1H", value: null }] },
      weather: {
        values: [
          {
            validTime: "2026-09-29T18:00:00+00:00/PT2H",
            value: [{ coverage: "slight_chance", weather: "thunderstorms", intensity: null, visibility: { unitCode: "wmoUnit:km", value: null }, attributes: [] }],
          },
          {
            validTime: "2026-09-29T20:00:00+00:00/PT1H",
            value: [{ coverage: null, weather: null, intensity: null, visibility: { unitCode: "wmoUnit:km", value: null }, attributes: [] }],
          },
        ],
      },
      // probabilityOfThunder deliberately absent: not every office publishes it.
      ...overrides,
    },
  };
}

const hourly = {
  properties: {
    updateTime: "2026-09-29T17:50:00+00:00",
    periods: [
      { number: 1, startTime: "2026-09-29T12:00:00-06:00", endTime: "2026-09-29T13:00:00-06:00", shortForecast: "Sunny" },
      { number: 2, startTime: "2026-09-29T13:00:00-06:00", endTime: "2026-09-29T14:00:00-06:00", shortForecast: "Slight Chance T-storms" },
    ],
  },
};

const forecast = {
  properties: {
    updateTime: "2026-09-29T17:50:00+00:00",
    periods: [
      {
        number: 1,
        name: "This Afternoon",
        startTime: "2026-09-29T12:00:00-06:00",
        endTime: "2026-09-29T18:00:00-06:00",
        isDaytime: true,
        shortForecast: "Sunny",
        detailedForecast: "Sunny, with a high near 72. South southwest wind around 10 mph.",
      },
    ],
  },
};

test("parseDuration handles the interval forms NWS uses", () => {
  assert.equal(parseDuration("PT1H"), HOUR);
  assert.equal(parseDuration("PT30M"), HOUR / 2);
  assert.equal(parseDuration("P1DT6H"), 30 * HOUR);
  assert.equal(parseDuration("P7D"), 168 * HOUR);
  for (const bad of ["P", "PT", "1H", "P1W", ""]) assert.throws(() => parseDuration(bad));
});

test("parseValidTime splits start and duration", () => {
  const { start, end } = parseValidTime("2026-09-29T18:00:00+00:00/PT3H");
  assert.equal(new Date(start).toISOString(), "2026-09-29T18:00:00.000Z");
  assert.equal(end - start, 3 * HOUR);
  assert.throws(() => parseValidTime("2026-09-29T18:00:00+00:00"));
});

test("expandLayer gives every hour of an interval the interval's value", () => {
  const hours = expandLayer({ values: [{ validTime: "2026-09-29T18:00:00+00:00/PT3H", value: 7 }] });
  assert.deepEqual([...hours.values()], [7, 7, 7]);
  assert.equal(expandLayer(undefined).size, 0);
});

test("convert applies declared units and rejects unknown ones", () => {
  assert.equal(convert("windSpeedMps", "wmoUnit:km_h-1", 36), 10);
  assert.equal(convert("windSpeedMps", "wmoUnit:kn", 10), 5.1);
  assert.equal(convert("temperatureC", "wmoUnit:degF", 212), 100);
  assert.equal(convert("mixingHeightM", "wmoUnit:ft", 10000), 3048);
  assert.equal(convert("windSpeedMps", "wmoUnit:km_h-1", null), null);
  assert.throws(() => convert("windSpeedMps", "wmoUnit:furlong_fortnight-1", 1), /unexpected NWS unit/);
});

test("describeWeather compacts conditions and drops empty ones", () => {
  assert.equal(describeWeather([{ coverage: "chance", intensity: "light", weather: "rain_showers" }]), "chance light rain_showers");
  assert.equal(describeWeather([{ coverage: null, weather: null, intensity: null }]), null);
  assert.equal(describeWeather(undefined), null);
});

test("buildSiteDocument produces one row per hour from the current hour", () => {
  const doc = buildSiteDocument({ site, point, grid: makeGrid(), hourly, forecast, now: NOW });

  // Current hour (18Z) through the end of the longest core interval (21Z + 27 h, exclusive).
  assert.equal(doc.hours[0].validAt, "2026-09-29T18:00:00.000Z");
  assert.equal(doc.hours.at(-1).validAt, "2026-09-30T23:00:00.000Z");
  assert.equal(doc.hours.length, 30);

  const [h18, h19, h20, h21] = doc.hours;
  assert.equal(h18.temperatureC, 21.1); // from the 17Z/PT3H interval
  assert.equal(h20.temperatureC, 22.2);
  assert.equal(h21.temperatureC, 15);
  assert.equal(h18.dewpointC, -1.7);
  assert.equal(h18.windSpeedMps, 5.1); // 18.52 km/h
  assert.equal(h18.windGustMps, 7.7); // 27.78 km/h
  assert.equal(h21.windGustMps, null); // gust interval ended at 21Z
  assert.equal(h18.windDirectionDeg, 200);
  assert.equal(h18.mixingHeightM, 2926);
  assert.equal(h18.transportWindSpeedMps, 7.2);
  assert.equal(h18.transportWindDirectionDeg, 230);
  assert.equal(h18.lightningActivityLevel, 2);
  assert.equal(h18.skyCoverPct, 12);
  assert.equal(h19.skyCoverPct, null);
  assert.equal(h18.ceilingHeightM, null);
  assert.equal(h18.thunderProbabilityPct, null); // layer absent
  assert.equal(h18.weather, "slight_chance thunderstorms");
  assert.equal(h20.weather, null);
  assert.equal(h18.shortForecast, "Sunny"); // 12:00 MDT = 18Z
  assert.equal(h19.shortForecast, "Slight Chance T-storms");
  assert.equal(h20.shortForecast, null);

  assert.deepEqual(doc.grid, { office: "BOI", x: 142, y: 88, elevationM: 1463 });
  assert.equal(doc.updateTime, "2026-09-29T17:42:11+00:00");
  assert.equal(doc.periods[0].name, "This Afternoon");
  assert.equal(doc.pageUrl, "https://forecast.weather.gov/MapClick.php?lat=43.6233&lon=-115.9808");
  assert.equal(doc.site.slug, "cervidae-peak");
});

test("buildSiteDocument caps the forecast at seven days", () => {
  const grid = makeGrid({
    temperature: { uom: "wmoUnit:degC", values: [{ validTime: "2026-09-29T18:00:00+00:00/P10D", value: 10 }] },
  });
  const doc = buildSiteDocument({ site, point, grid, hourly: null, forecast: null, now: NOW });
  assert.equal(doc.hours.length, 168);
  assert.deepEqual(doc.periods, []);
  assert.equal(doc.hours[0].shortForecast, null);
});

test("buildSiteDocument fails loudly on an unexpected unit", () => {
  const grid = makeGrid({ windSpeed: { uom: "wmoUnit:mi_h-1", values: [{ validTime: "2026-09-29T18:00:00+00:00/PT1H", value: 10 }] } });
  assert.throws(() => buildSiteDocument({ site, point, grid, hourly, forecast, now: NOW }), /unexpected NWS unit/);
});

function router(routes) {
  const calls = [];
  const getJson = async (url) => {
    calls.push(url);
    if (!(url in routes)) throw new Error(`unexpected URL ${url}`);
    const value = routes[url];
    if (value instanceof Error) throw value;
    return value;
  };
  return { getJson, calls };
}

test("fetchSiteDocument follows the point's links and tolerates a failed hourly forecast", async () => {
  const warnings = [];
  const { getJson, calls } = router({
    [`${API}/points/43.6233,-115.9808`]: point,
    [point.properties.forecastGridData]: makeGrid(),
    [point.properties.forecastHourly]: new Error("GET answered 500"),
    [point.properties.forecast]: forecast,
  });
  const doc = await fetchSiteDocument(site, getJson, { now: NOW, warn: (m) => warnings.push(m) });
  assert.equal(calls[0], `${API}/points/43.6233,-115.9808`);
  assert.equal(doc.hours[0].shortForecast, null);
  assert.equal(doc.periods.length, 1);
  assert.match(warnings.join("\n"), /hourly forecast unavailable/);
});

test("fetchSiteDocument rejects a launch NWS does not cover", async () => {
  const { getJson } = router({ [`${API}/points/46.0000,7.0000`]: null });
  await assert.rejects(fetchSiteDocument({ ...site, latitude: 46, longitude: 7 }, getJson, { now: NOW, warn() {} }), /outside the US/);
});

test("fetchSiteDocument warns when the grid is stale", async () => {
  const warnings = [];
  const grid = makeGrid({ updateTime: "2026-09-28T00:00:00+00:00" });
  const { getJson } = router({
    [`${API}/points/43.6233,-115.9808`]: point,
    [point.properties.forecastGridData]: grid,
    [point.properties.forecastHourly]: hourly,
    [point.properties.forecast]: forecast,
  });
  await fetchSiteDocument(site, getJson, { now: NOW, warn: (m) => warnings.push(m) });
  assert.match(warnings.join("\n"), /h old/);
});

test("fetchOfficeDocument keeps the AFD and records an office with no Soaring Forecast", async () => {
  const { getJson } = router({
    [`${API}/products/types/AFD/locations/BOI`]: { "@graph": [{ id: "abc-123" }, { id: "older" }] },
    [`${API}/products/abc-123`]: {
      id: "abc-123",
      productCode: "AFD",
      productName: "Area Forecast Discussion",
      issuanceTime: "2026-09-29T15:12:00+00:00",
      productText: "AREA FORECAST DISCUSSION ...",
    },
    [`${API}/products/types/SRG/locations/BOI`]: { "@graph": [] },
  });
  const doc = await fetchOfficeDocument("BOI", getJson, { now: NOW, warn() {} });
  assert.equal(doc.products.afd.issuanceTime, "2026-09-29T15:12:00+00:00");
  assert.equal(doc.products.afd.text, "AREA FORECAST DISCUSSION ...");
  assert.equal(doc.products.srg, null);
});

function fakeFetch(statuses) {
  let calls = 0;
  const fetchImpl = async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    if (status === "network") throw new TypeError("fetch failed");
    return { status, ok: status >= 200 && status < 300, json: async () => ({ status }) };
  };
  return { fetchImpl, count: () => calls };
}

test("createClient retries transient failures, returns null on 404, stops on other 4xx", async () => {
  let fake = fakeFetch([503, "network", 429, 200]);
  assert.deepEqual(await createClient({ fetchImpl: fake.fetchImpl, retryDelayMs: 1 })("u"), { status: 200 });
  assert.equal(fake.count(), 4);

  fake = fakeFetch([404]);
  assert.equal(await createClient({ fetchImpl: fake.fetchImpl, retryDelayMs: 1 })("u"), null);

  fake = fakeFetch([400]);
  await assert.rejects(createClient({ fetchImpl: fake.fetchImpl, retryDelayMs: 1 })("u"), /answered 400/);
  assert.equal(fake.count(), 1);

  fake = fakeFetch([500]);
  await assert.rejects(createClient({ fetchImpl: fake.fetchImpl, retryDelayMs: 1 })("u"), /answered 500/);
  assert.equal(fake.count(), 4);
});
