#!/usr/bin/env bash
# Builds one model for every launch in the published sites.json, then
# publishes the result to the dataset bucket.
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
status=0

"$here/run-annotated.sh" "$model build" pnpm exec meteo forecast build --model "$model" --sites dataset --output data || status=1
"$here/run-annotated.sh" "$model publish" pnpm exec meteo forecast publish --model "$model" --data data || status=1

exit "$status"
