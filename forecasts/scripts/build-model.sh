#!/usr/bin/env bash
# Builds one model for every launch in the published sites.json, then
# publishes the result to the dataset bucket.
#
# Builds are idempotent: if the provider has no complete new run, or the
# published run is already current, nothing is written and publish reports
# "No new ... output to upload". Publish runs even after a failed build so a
# completed model is never stranded; the script still exits non-zero so the
# workflow step shows the failure.
#
# Usage: scripts/build-model.sh <model-slug>
set -uo pipefail

model="${1:?usage: scripts/build-model.sh <model-slug>}"
status=0

if ! pnpm exec meteo forecast build --model "$model" --sites dataset --output data; then
  echo "::warning::$model build failed"
  status=1
fi

if ! pnpm exec meteo forecast publish --model "$model" --data data; then
  echo "::error::$model publish failed"
  status=1
fi

exit "$status"
