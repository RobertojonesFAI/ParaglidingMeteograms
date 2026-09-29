# ParaglidingMeteograms

Soaring forecasts for paragliding launches, starting with Cervidae Peak near Boise, Idaho.

For every launch, the pipeline samples high-resolution weather models and publishes an
hour-by-hour meteogram: thermal strength (w\*), boundary-layer top, cloud base, usable-lift
top, and wind at each height. New launches are added by editing one file.

## How it works

```
forecasts/sites.json ──► GitHub Actions ──► Cloudflare R2 bucket ──► website (web/, coming next)
   (the launches)        every 15 min        public JSON documents      reads and draws the meteograms
```

- **`forecasts/`** is the forecast operator. It pins the
  [`@azohra/meteo.forecast`](https://meteo.azohra.com/docs/forecast/) engine, which downloads
  NOAA model data, samples it at each launch, derives the soaring quantities, and publishes
  versioned JSON documents.
- **GitHub Actions** runs the engine on a schedule. Builds are idempotent: a tick with no new
  model run publishes nothing.
- **Cloudflare R2** stores the published dataset. The website reads it.

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

The scheduled workflows are skipped until `METEO_R2_BUCKET` is set, so nothing fails before
setup is finished.

## Adding a launch

1. Add an entry to [`forecasts/sites.json`](forecasts/sites.json):

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
   - Launch-specific details the engine does not use (launch direction, good wind range,
     landing zone, notes) belong in the website, not here.
2. Commit to `main`. *Publish launches* runs automatically, and the next *Build forecasts* tick
   includes the new launch.

The *Check* workflow validates `sites.json` on every pull request and push.

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
```

The document schemas are described in the
[meteo contract reference](https://meteo.azohra.com/docs/briefing/contract/). A reader should
check that a profile's `referenceTime` matches its model's manifest before drawing it.

## Local development

Requires Node 22 or later and pnpm.

```sh
cd forecasts
pnpm install
pnpm run check                     # validate sites.json
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

- GitHub disables scheduled workflows in a public repository after 60 days without repository
  activity. Re-enable *Build forecasts* from the Actions tab if that happens.
- Forecast documents are derived from NOAA data (public domain) and, if HRDPS is enabled, from
  ECCC data under the
  [ECCC Data Server End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/).
  Keep the provider attribution wherever the forecasts are shown.
- These are model forecasts, not observations. They do not replace a pilot's own assessment of
  conditions at launch.

## Credits

Forecast engine: [meteo by Azohra](https://meteo.azohra.com/) (MIT licence).
