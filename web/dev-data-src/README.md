# Sample data sources

Inputs for `scripts/make-dev-data.mjs`, which builds the local sample dataset
served at `/data` during `pnpm dev`. Nothing here is a forecast.

- `convective-cycle.profile.json`: a synthetic scenario profile from
  [meteo by Azohra](https://github.com/azohra/meteo) (`scenarios/generated/`),
  MIT licence, Copyright (c) 2026 Justin Watts. It is re-timed and re-labelled
  for the local launches by the generator.
- `ensemble-wide.profile.json`: a synthetic ensemble scenario from the same
  source and licence, used for the sample GEPS meteogram.
- `models.json`: the model catalogue shipped with `@azohra/meteo.forecast`
  (MIT licence, same copyright).
