#!/usr/bin/env bash
# Builds one model for the launches inside its grid, then publishes the result
# to the dataset bucket.
#
# The launches come from the published sites.json, filtered by
# scripts/model-sites.mjs: the engine fails a whole build when one launch is
# outside the model's grid (HRRR has no Mexico), so each model only sees the
# launches it covers. A model that covers none is skipped.
#
# Builds are idempotent: if the provider has no complete new run, or the
# published run is already current, nothing is written and publish reports
# "No new ... output to upload". Publish runs even after a failed build so a
# completed model is never stranded; the script still exits non-zero so the
# workflow step shows the failure. Errors are repeated as annotations
# (scripts/run-annotated.sh) so they are visible on the run's summary page.
#
# Usage: scripts/build-model.sh <model-slug>
set -uo pipefail

model="${1:?usage: scripts/build-model.sh <model-slug>}"
here="$(dirname "$0")"
sites="$(mktemp -d)/sites.json"

if ! count="$(node "$here/model-sites.mjs" --model "$model" --output "$sites")"; then
  echo "::error title=$model sites::could not read the published sites.json"
  exit 1
fi
if [ "$count" = "0" ]; then
  echo "$model covers none of the launches; nothing to build."
  exit 0
fi

status=0
"$here/run-annotated.sh" "$model build" pnpm exec meteo forecast build --model "$model" --sites "$sites" --output data || status=1
"$here/run-annotated.sh" "$model publish" pnpm exec meteo forecast publish --model "$model" --data data || status=1

exit "$status"
