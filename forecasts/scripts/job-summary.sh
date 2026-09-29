#!/usr/bin/env bash
# Writes a job's per-model results to the GitHub job summary and fails the job
# only when every model failed (one provider outage should not paint the run
# red while the other models published).
#
# Usage: RESULTS="HRRR 3 km=success;GFS 25 km=failure" scripts/job-summary.sh
set -euo pipefail

: "${RESULTS:?set RESULTS to \"Name=outcome;Name=outcome\"}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
any_ok=false

{
  echo "| Model | Result |"
  echo "| --- | --- |"
} >> "$summary"

IFS=';' read -ra entries <<< "$RESULTS"
for entry in "${entries[@]}"; do
  name="${entry%%=*}"
  outcome="${entry#*=}"
  echo "| $name | $outcome |" >> "$summary"
  [ "$outcome" = "success" ] && any_ok=true
done

if [ "$any_ok" != true ]; then
  echo "::error::every model in this job failed this tick"
  exit 1
fi
