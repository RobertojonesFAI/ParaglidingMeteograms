# Website

The public site and its admin page: an [Astro](https://astro.build) static site served by one
Cloudflare Worker.

| Page | What it shows |
| --- | --- |
| `/` | Map and list of launches |
| `/launches/<slug>` | Day and model selectors, the soaring meteogram, the Skew-T sounding for any hour of the day (annotated with the thermal zone, top of lift, cloud base, inversions and cloud layers, with a plain-language reading beside it), the sunlight map (W/m² on the terrain every 15 minutes, with a slider, play button and a daily curve for the launch or a tapped spot), the NWS hourly charts (wind, gusts, transport wind, direction against the launch's wind window, mixing height, clouds and storms), the ECMWF IFS hourly charts (wind, gusts, 850 hPa wind, boundary-layer height, cloud layers), and the NWS text products with a Skew-T of the latest weather balloon (and the Soaring Forecast's model hours), read for pilots |
| `/about` | What the charts show, data sources, safety note |
| `/admin` | Add and edit launches (Cloudflare Access login) |

Forecast data is not baked into the pages. The browser reads it from `/data/...` on every visit,
and the Worker serves those paths straight from the R2 bucket binding, so the bucket stays
private and the pages are always as fresh as the dataset.

```
browser ──► Worker ──► static pages (dist/)             everything except the two routes below
               ├─────► R2 bucket binding (DATA)           GET /data/<key>
               └─────► GitHub API (one commit per save)   /api/admin/launches, behind Cloudflare Access
```

## Launch data

A launch lives in two files so the forecast engine's catalogue keeps exactly the fields the
engine accepts:

| File | Holds | Read by |
| --- | --- | --- |
| [`forecasts/sites.json`](../forecasts/sites.json) | slug, name, coordinates, time zone | forecast workflows, site build |
| [`web/src/data/launches.json`](src/data/launches.json) | facing, wind window, wind and gust limits, region, notes | site build |

Every slug must appear in both. The admin page writes both in one commit; the *Check* workflow
and the site build fail if they disagree.

## Local development

Requires Node 22 or later and pnpm.

```sh
cd web
pnpm install
pnpm dev            # http://localhost:4321 with a synthetic sample dataset (clearly labelled)
pnpm test           # Worker, admin and launch-rule unit tests
pnpm run check      # type checks for the site and the Worker
```

`pnpm dev` regenerates `dev-data/` from [`dev-data-src/`](dev-data-src/README.md) and serves it
at `/data`. The sample documents are validated against the same meteo contract the site uses in
production.

To run the real Worker locally (static assets, R2 binding, admin API) use `pnpm run preview`,
after loading the sample dataset into the local R2 simulation:

```sh
pnpm run dev-data
cd dev-data && for f in $(find . -type f | sed 's#^\./##'); do
  npx wrangler r2 object put "paragliding-meteograms-data/$f" --file "$f" --content-type application/json --local
done; cd ..
pnpm run preview    # http://localhost:8787
```

## Deploying on Cloudflare (one time)

1. **Create the Worker from this repository.** In the Cloudflare dashboard, *Workers & Pages →
   Create → Import a repository*, choose this repository and set:

   | Setting | Value |
   | --- | --- |
   | Project name | `paragliding-meteograms` (must match `name` in `wrangler.jsonc`) |
   | Root directory | `web` |
   | Build command | `pnpm run build` |
   | Deploy command | `npx wrangler deploy` |

   Every push to `main` then rebuilds and deploys the site.
2. **Check the bucket name.** `bucket_name` in [`wrangler.jsonc`](wrangler.jsonc) must be the same
   bucket the forecast workflows publish to (the `METEO_R2_BUCKET` repository variable). The
   default is `paragliding-meteograms-data`.
3. **Connect the domain.** On the Worker, *Settings → Domains & Routes → Add → Custom domain*.
   Then set `site` in [`astro.config.mjs`](astro.config.mjs) to the domain's URL.

## Admin page setup

The admin API refuses every request until all of this is in place.

1. **Protect `/admin` with Cloudflare Access.** In *Zero Trust → Access → Applications*, add a
   *self-hosted* application for your domain with two paths, `admin` and `api/admin`, and a policy
   that allows only your email. Access then asks for your email and sends a one-time code; no
   passwords are stored anywhere.
2. **Tell the Worker which Access application to trust.** Put the application's *Audience (AUD)
   tag* in `ACCESS_AUD` and your team domain (`<team>.cloudflareaccess.com`) in
   `ACCESS_TEAM_DOMAIN`, in the `vars` of [`wrangler.jsonc`](wrangler.jsonc), and commit. These
   values are not secret. The Worker verifies the Access token on every admin request, so the API
   stays closed even if the Access application is ever removed. `ADMIN_EMAILS` optionally narrows
   access further.
3. **Give the Worker a GitHub token.** Create a fine-grained personal access token limited to this
   repository with *Contents: Read and write*, and add it to the Worker as a **secret** named
   `GITHUB_TOKEN` (*Settings → Variables and Secrets → Add → Secret*). Never commit it or paste it
   anywhere else.

### What a save does

Saving a launch makes one commit on `main` that updates both launch files. That commit triggers:

- *Publish launches* (GitHub Actions): publishes the new `sites.json` and measures the launch's
  terrain;
- the site rebuild (Cloudflare): the new launch page appears in 1–2 minutes;
- the next *NWS forecast* run (within the hour) and the next model run (up to 6 hours) add its
  forecasts.

A slug never changes after a launch is created. Removing a launch is not in the admin page yet;
delete it from both files by hand.

## Units

The NWS charts use mph, feet and °F. The meteogram is drawn by
[meteo](https://meteo.azohra.com/docs/briefing/reading-a-meteogram/) with heights in metres and
feet and wind barbs and gusts in km/h.
