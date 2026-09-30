# ParaglidingMeteograms

Soaring forecasts for paragliding launches, starting with Cervidae Peak near Boise, Idaho.

For every launch, the pipeline samples high-resolution weather models and publishes an
hour-by-hour meteogram: thermal strength (w\*), boundary-layer top, cloud base, usable-lift
top, and wind at each height. Alongside it, the official National Weather Service point
forecast for the launch is published every hour, a Skew-T sounding explains each hour in plain
words, and a sunlight map shows, every 15 minutes of the day, how much sun reaches each slope
around the launch. New launches are added from the
site's admin page.

## How it works

```
forecasts/sites.json ──► GitHub Actions ──► Cloudflare R2 bucket ──► website (web/)
   (the launches)        on a schedule       JSON documents            Cloudflare Worker: pages + /data
```

- **`forecasts/`** is the forecast operator. It pins the
  [`@azohra/meteo.forecast`](https://meteo.azohra.com/docs/forecast/) engine, which downloads
  NOAA and Environment Canada (ECCC) model data, samples it at each launch, derives the
  soaring quantities, and publishes
  versioned JSON documents. It also fetches the NWS forecast for each launch from
  [api.weather.gov](https://www.weather.gov/documentation/services-web-api).
- **GitHub Actions** runs both on a schedule. Model builds are idempotent: a tick with no new
  model run publishes nothing.
- **Cloudflare R2** stores the published dataset.
- **[`web/`](web/README.md)** is the public site and its admin page, served by a Cloudflare
  Worker that reads the bucket directly. Its README covers deployment and the admin setup.

| Workflow | When | What it does |
| --- | --- | --- |
| Check | Every pull request and push | Forecasts: validates the launches, unit tests, engine dry run, live NWS fetch without publishing. Web: unit tests, type checks, sample dataset, site build, Worker bundle |
| Publish launches | `sites.json` or the engine changes | Publishes `sites.json`, `models.json`, `site-context.json`, and the sunlight-map terrain tiles of new or moved launches |
| Build forecasts | Every 15 minutes | Builds and publishes the model meteograms (three parallel jobs: NOAA, ECCC Datamart, ECCC mirror) |
| NWS forecast | Every hour at :20 | Fetches and publishes the NWS forecast for every launch, and the latest weather-balloon soundings from each launch's nearest upper-air station |
| ECMWF forecast | Every hour at :40 | Fetches and publishes the ECMWF IFS forecast for every launch (from Open-Meteo) |

GitHub starts scheduled runs late, sometimes by several hours. The products that come out at a
set time of day, the NWS Soaring Forecast, the Area Forecast Discussion and the 00/12 UTC
weather balloons, are therefore also refreshed by the site's Worker on a Cloudflare Cron Trigger
every 10 minutes ([`web/worker/refresh.ts`](web/worker/refresh.ts)), with the same document
builders the workflows use. It rewrites a document only when NWS or the balloon archive has
something new, and records each run in `status/refresh.json`.

## Launches

| Slug | Name | Latitude | Longitude | Time zone |
| --- | --- | --- | --- | --- |
| `cervidae-peak` | Cervidae Peak | 43.62332 | -115.98076 | America/Boise |

## Models

| Slug | Provider | Grid | Horizon | Use |
| --- | --- | --- | --- | --- |
| `hrrr-conus` | NOAA | 3 km | 48 h | Main forecast for today and tomorrow |
| `hrdps-continental` | ECCC | 2.5 km | 48 h | Second high-resolution opinion for today and tomorrow |
| `rrfs` | NOAA | 3 km | 84 h | NAM's successor; experimental feed |
| `rdps` | ECCC | 10 km | 84 h | Regional model out to day 3 |
| `gfs` | NOAA | 25 km | 16 days | Long-range trend |
| `gdps` | ECCC | 15 km | 10 days | Long-range trend, second opinion |
| `geps` | ECCC | 50 km | 16 days | 21-member ensemble: how much the long range can be trusted |

The site lists the models in this order and opens the first one whose run covers the day
being viewed.

Models deliberately not used:

- **NAM and SREF**: NOAA retires both on 2026-10-06; RRFS replaces NAM.
- **RAP**: 13 km with the same physics as HRRR, which already covers the launches at 3 km.

ECMWF IFS is shown in its own panel instead of the meteogram (see below): its open data has no
surface heat flux, so the engine cannot derive thermal strength from it, and the engine has no
ECMWF source.

ECCC publishes each run as whole-domain files (4 to 14 GB per run for these models), so the
two ECCC jobs are the slow part of *Build forecasts*. HRDPS is a Canadian domain; Boise is
inside it, near its southern edge.

A 3 km model sees a smoothed mountain, so its terrain at a launch is usually lower than the
real launch. The engine measures the real launch elevation separately (`site-context.json`)
and records the model's terrain in every profile (`site.modelElevationM`).

## National Weather Service forecast

The NWS forecast is the forecasters' official forecast on a 2.5 km grid: the same data behind
the [forecast.weather.gov hourly graph](https://forecast.weather.gov/MapClick.php?lat=43.6233&lon=-115.9808&unit=0&lg=english&FcstType=graphical)
for each launch. It complements the models with a human-edited forecast and fields pilots use
directly:

- hourly wind, gusts and direction (10 m), sky cover, temperature, dew point, humidity
- **mixing height** (above ground) and **transport wind** (mean wind through the mixed layer)
- probability of precipitation and of thunder, lightning activity level, ceiling, visibility
- the hourly short text ("Slight Chance T-storms") and the 12-hour text periods
- per forecast office: the latest **Area Forecast Discussion**, and the **Soaring Forecast**
  when the office issues one

No API key is needed. NWS asks each client to identify itself; the requests send
`ParaglidingMeteograms/0.1 (+https://github.com/RobertojonesFAI/ParaglidingMeteograms)` as the
User-Agent, which the `NWS_USER_AGENT` environment variable can override (for example to add a
contact email). NWS only covers the United States; a launch outside it is reported as failed in
the NWS run and is still built by the models that cover it.

Speeds are published in m/s, heights in metres and temperatures in °C, like the model
documents; each document's `units` field describes every column.

## ECMWF forecast

ECMWF's real-time forecasts have been open data (CC BY 4.0) since 1 October 2025.
[`forecasts/scripts/ecmwf.mjs`](forecasts/scripts/ecmwf.mjs) reads them for each launch from
[Open-Meteo's ECMWF API](https://open-meteo.com/en/docs/ecmwf-api), two requests per launch:

- **IFS HRES, 9 km** (`ecmwf_ifs`): 10 m wind, gusts and direction, boundary-layer height,
  total/low/mid/high cloud, precipitation, CAPE, temperature, dew point, sunlight. Hourly to
  90 h, then 3- and 6-hourly (Open-Meteo interpolates to hours).
- **IFS 0.25°** (`ecmwf_ifs025`): wind and height at 850 and 700 hPa (the 9 km feed has no
  pressure levels).

The run time comes from Open-Meteo's per-model metadata (`/data/<model>/static/meta.json`).
Documents use the same units as the NWS ones (m/s, m, °C); `units` in each document lists them.
Open-Meteo's free API is for **non-commercial use**: if the site ever carries ads or charges,
get an Open-Meteo API key or read ECMWF's open data directly. ECMWF and Open-Meteo must be
credited wherever the data is shown (the site footer does).

## Weather-balloon soundings

NWS weather balloons (radiosondes) go up at 00 and 12 UTC. [`forecasts/scripts/raob.mjs`](forecasts/scripts/raob.mjs)
reads the two latest flights of each launch's nearest upper-air station (Boise, KBOI, for the
Boise launches; any station within 300 km from the list in
[`forecasts/scripts/lib/raob.mjs`](forecasts/scripts/lib/raob.mjs)) from the
[Iowa Environmental Mesonet's archive](https://mesonet.agron.iastate.edu/archive/raob/)
(`/json/raob.py?ts=YYYYmmddHH00&station=KBOI`) and publishes them as `raob/sites/<slug>.json`.
Levels that arrive without a height get one from the hypsometric equation. Between workflow
runs, the Worker's 10-minute refresh looks for each new flight from 45 minutes after its launch
time (once an hour after four hours without it) and puts it in front of the previous one.

The launch page draws them as a Skew-T in the forecast-discussion section, together with the
NWS Soaring Forecast, which the page parses from its text (`web/src/lib/srg.ts`): the morning
flight is read the way the Soaring Forecast is made, a thermal leaving the ground at the forecast
high and rising until it meets the morning temperature line; the Soaring Forecast's model hours
(9 AM to 6 PM, temperature and wind only) are offered too. Without a balloon file, the Soaring
Forecast's own balloon table is used.

## Sunlight map

Each launch page has a map of the sunlight (W/m²) reaching the ground within 15 km of the
launch, with a slider from sunrise to sunset in 15-minute steps, a play button, and the day's
curve for the launch or any spot the user taps.

The ground is prepared once per launch by [`forecasts/scripts/solar.mjs`](forecasts/scripts/solar.mjs)
(run by *Publish launches*) and cut into map tiles, zoom 11 to 14:

- **surface normal** of every pixel (which way the ground faces, and how steeply), from the
  [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) 1/3 arc-second elevation model (~10 m);
- **sky-view factor** of every pixel (how much open sky it sees, for diffuse light);
- **horizon angles** in 18 directions on a ~28 m grid, traced out to 20 km over the 3DEP
  1 arc-second model (~30 m) with earth curvature and refraction, so ridges up to 20 km away
  cast their shadows.

Outside 3DEP's coverage the builder falls back to Copernicus GLO-30 for both. A launch takes
about 2-3 minutes and ~65 MB of tiles (~450 tiles of 120-250 KB); tiles are only rebuilt when a
launch is added or moved, or when `ALGORITHM_VERSION` in
[`forecasts/scripts/lib/solar.mjs`](forecasts/scripts/lib/solar.mjs) changes.

The browser does the rest for each 15-minute step: the sun's position
([NOAA solar calculator equations](https://gml.noaa.gov/grad/solcalc/calcdetails.html),
checked in the tests against NREL's Solar Position Algorithm), a clear sky (Meinel direct beam with
Laue's altitude correction, see [PVEducation](https://www.pveducation.org/pvcdrom/properties-of-sunlight/calculation-of-solar-insolation)),
and the cloud cover of the model selected on the page (Kasten & Czeplak 1980). Clouds are one
value for the whole map, taken at the launch. Haze and smoke are not modelled.

## One-time setup

1. **Create an R2 bucket** in Cloudflare (for example `paragliding-meteograms-data`).
2. **Create an R2 API token** with object read and write permission, scoped to that bucket
   only. Note its access key ID, secret access key, and the S3 endpoint
   `https://<account-id>.r2.cloudflarestorage.com`.
3. **Add the credentials to this repository** under *Settings → Secrets and variables →
   Actions*:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Secret | `R2_ACCESS_KEY_ID` | token access key ID |
   | Secret | `R2_SECRET_ACCESS_KEY` | token secret access key |
   | Variable | `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | Variable | `METEO_R2_BUCKET` | bucket name |

   Do not set `METEO_DATA_BASE`: with the S3 credentials present, the engine reads its own
   publish state through the authenticated endpoint.
4. **Publish the launches**: *Actions → Publish launches → Run workflow*. This uploads
   `sites.json`, measures each launch's terrain into `site-context.json`, and uploads the model
   catalogue `models.json`.
5. **Build the first forecast**: *Actions → Build forecasts → Run workflow*, or wait for the next
   15-minute tick. The job summary shows the result for each model.
6. **Fetch the first NWS forecast**: *Actions → NWS forecast → Run workflow*, or wait for the
   next hour. The job summary shows the next 12 hours for each launch.

The scheduled workflows are skipped until `METEO_R2_BUCKET` is set, so nothing fails before
setup is finished.

## Adding a launch

Use the site's admin page (`/admin`): place the launch on the map, choose the direction it faces
and its wind limits, and save. The page commits the change for you. See
[web/README.md](web/README.md#admin-page-setup) for the one-time setup.

To add one by hand instead, edit both files in one commit:

1. Add the identity to [`forecasts/sites.json`](forecasts/sites.json):

   ```json
   {
     "slug": "new-launch",
     "name": "New Launch",
     "latitude": 43.12345,
     "longitude": -116.12345,
     "timeZone": "America/Boise"
   }
   ```

   - `slug` is permanent. Renaming it creates a new launch and orphans the old one's history.
   - Use lowercase letters, digits, and hyphens only.
   - Do not add elevation or any other field. The engine rejects unknown fields and measures
     elevation itself.
2. Add the same slug to [`web/src/data/launches.json`](web/src/data/launches.json) with the
   direction the launch faces (`facingDeg`), the wind window half-width, the wind and gust limits
   in mph, a region label and notes.
3. Commit to `main`. *Publish launches* runs automatically and the site rebuilds. The next *NWS
   forecast* run (within the hour) and each model's next new run (up to 6 hours, 12 for GDPS and
   GEPS: a build only publishes when a model's run advances) add the launch's forecasts.

The *Check* workflow validates both files on every pull request and push.

## Published dataset

Everything lives at the root of the bucket:

```
models.json                          model catalogue (what each model publishes)
sites.json                           the launches
site-context.json                    measured elevation, terrain and land cover per launch
runs.json                            latest published run of every model
<model>/manifest.json                current run of one model
<model>/sites/<slug>.json            one launch's hour-by-hour profile
<model>/history/<slug>/<YYYY-MM>.jsonl.gz   append-only monthly archive of every run
nws/manifest.json                    what the latest NWS run published, per launch and office
nws/sites/<slug>.json                one launch's NWS forecast: hourly rows and text periods
nws/offices/<office>.json            Area Forecast Discussion and Soaring Forecast for an office
raob/sites/<slug>.json               the nearest upper-air station's two latest balloon soundings
status/refresh.json                  what the Worker's last 10-minute refresh found (offices, balloons)
ecmwf/manifest.json                  what the latest ECMWF fetch published, and the model runs
ecmwf/sites/<slug>.json              one launch's ECMWF IFS hourly forecast
solar/<slug>/index.json              sunlight-map terrain: tile ranges, encoding, sources, launch summary
solar/<slug>/<generation>/<z>/<x>/<y>.bin.gz   sunlight-map terrain tiles (immutable; the generation id changes with the inputs)
```

The model document schemas are described in the
[meteo contract reference](https://meteo.azohra.com/docs/briefing/contract/). A reader should
check that a profile's `referenceTime` matches its model's manifest before drawing it.

The NWS documents are this repository's own format (`schemaVersion: 1`), built in
[`forecasts/scripts/lib/nws.mjs`](forecasts/scripts/lib/nws.mjs). Each hourly row has
`validAt` (UTC) and one column per field; a field NWS does not provide for that hour is `null`.

## Local development

Requires Node 22 or later and pnpm.

```sh
cd forecasts
pnpm install
pnpm run check                     # validate sites.json
pnpm test                          # unit tests
pnpm run nws --output data         # fetch the NWS forecast into data/nws/ without publishing
pnpm exec meteo forecast build --model hrrr-conus --sites ./sites.json --output data --dry-run
```

A real local build needs network access to NOAA's public buckets and ECCC's Datamart
(`dd.weather.gc.ca`, or its mirror `hpfx.collab.science.gc.ca`). Publishing needs the same four
variables the workflows use (`METEO_S3_ENDPOINT`, `METEO_R2_BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`).

## Upgrading the engine

```sh
cd forecasts
pnpm add -E @azohra/meteo.forecast@<version>
pnpm run check
```

Commit `package.json` and `pnpm-lock.yaml`. The lockfile change triggers *Publish launches*,
which republishes `models.json` for the new engine version.

## Operational notes

- Terrain context (`site-context.json`) is measured by
  [`forecasts/scripts/terrain.mjs`](forecasts/scripts/terrain.mjs), which runs the engine's own
  measurement on map tiles joined across tile edges. Engine 0.6.0 stops when a launch is within
  about 10 km of a 1° tile edge, and the 116°W meridian runs through the Boise foothills.
- Sunlight-map tiles of an earlier generation (a launch that moved, or an algorithm change)
  stay in the bucket but are no longer referenced; they can be deleted from `solar/<slug>/`
  by hand.
- GitHub disables scheduled workflows in a public repository after 60 days without repository
  activity. Re-enable *Build forecasts* and *NWS forecast* from the Actions tab if that happens.
- Forecast documents are derived from NOAA data, including the National Weather Service
  forecast (public domain), and from ECCC data (HRDPS, RDPS, GDPS, GEPS) under the
  [ECCC Data Server End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/).
  The sunlight map's terrain comes from USGS 3DEP (public domain). ECMWF forecasts are
  © ECMWF under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), served by
  [Open-Meteo](https://open-meteo.com/) (free for non-commercial use).
  Keep the provider attribution wherever the forecasts are shown.
- These are model forecasts, not observations. They do not replace a pilot's own assessment of
  conditions at launch.

## Credits

Forecast engine: [meteo by Azohra](https://meteo.azohra.com/) (MIT licence).
