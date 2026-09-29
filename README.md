# ParaglidingMeteograms

Soaring forecasts for paragliding launches, starting with Cervidae Peak near Boise, Idaho.

For every launch, the pipeline samples high-resolution weather models and publishes an
hour-by-hour meteogram: thermal strength (w\*), boundary-layer top, cloud base, usable-lift
top, and wind at each height. Alongside it, the official National Weather Service point
forecast for the launch is published every hour. New launches are added from the site's admin
page.

## How it works

```
forecasts/sites.json ──► GitHub Actions ──► Cloudflare R2 bucket ──► website (web/)
   (the launches)        on a schedule       JSON documents            Cloudflare Worker: pages + /data
```

- **`forecasts/`** is the forecast operator. It pins the
  [`@azohra/meteo.forecast`](https://meteo.azohra.com/docs/forecast/) engine, which downloads
  NOAA model data, samples it at each launch, derives the soaring quantities, and publishes
  versioned JSON documents. It also fetches the NWS forecast for each launch from
  [api.weather.gov](https://www.weather.gov/documentation/services-web-api).
- **GitHub Actions** runs both on a schedule. Model builds are idempotent: a tick with no new
  model run publishes nothing.
- **Cloudflare R2** stores the published dataset.
- **[`web/`](web/README.md)** is the public site and its admin page, served by a Cloudflare
  Worker that reads the bucket directly. Its README covers deployment and the admin setup.

| Workflow | When | What it does |
| --- | --- | --- |
| Check | Every pull request and push | Forecasts: validates the launches, unit tests, engine dry run, live NWS fetch without publishing. Web: unit tests, type checks, sample dataset, site build |
| Publish launches | `sites.json` or the engine changes | Publishes `sites.json`, `models.json`, `site-context.json` |
| Build forecasts | Every 15 minutes | Builds and publishes the model meteograms |
| NWS forecast | Every hour at :20 | Fetches and publishes the NWS forecast for every launch |

## Launches

| Slug | Name | Latitude | Longitude | Time zone |
| --- | --- | --- | --- | --- |
| `cervidae-peak` | Cervidae Peak | 43.62332 | -115.98076 | America/Boise |

## Models

| Slug | Grid | Horizon | Use |
| --- | --- | --- | --- |
| `hrrr-conus` | 3 km | 48 h | Main forecast for today and tomorrow |
| `rrfs` | 3 km | 84 h | NAM's successor; experimental feed |
| `gfs` | 25 km | 16 days | Long-range trend only |
| `hrdps-continental` | 2.5 km | 48 h | Opt-in (`ENABLE_HRDPS=true`); coverage of Boise not yet confirmed |

NAM is deliberately not used: NOAA retires it on 2026-10-06.

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
   | Variable (optional) | `ENABLE_HRDPS` | `true` to try the Canadian HRDPS model |

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
   forecast* run (within the hour) and the next new model run (up to 6 hours: a build only
   publishes when a model's run advances) add the launch's forecasts.

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

A real local build needs network access to NOAA's public buckets. Publishing needs the same four
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
- GitHub disables scheduled workflows in a public repository after 60 days without repository
  activity. Re-enable *Build forecasts* and *NWS forecast* from the Actions tab if that happens.
- Forecast documents are derived from NOAA data, including the National Weather Service
  forecast (public domain), and, if HRDPS is enabled, from ECCC data under the
  [ECCC Data Server End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/).
  Keep the provider attribution wherever the forecasts are shown.
- These are model forecasts, not observations. They do not replace a pilot's own assessment of
  conditions at launch.

## Credits

Forecast engine: [meteo by Azohra](https://meteo.azohra.com/) (MIT licence).
