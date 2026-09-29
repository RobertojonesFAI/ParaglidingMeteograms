# Sample data sources

Inputs for `scripts/make-dev-data.mjs`, which builds the local sample dataset
served at `/data` during `pnpm dev`. Nothing here is a forecast.

- `convective-cycle.profile.json`: a synthetic scenario profile from
  [meteo by Azohra](https://github.com/azohra/meteo) (`scenarios/generated/`),
  MIT licence, Copyright (c) 2026 Justin Watts. It is re-timed and re-labelled
  for the local launches by the generator.
- `models.json`: the model catalogue shipped with `@azohra/meteo.forecast`
  (MIT licence, same copyright).
