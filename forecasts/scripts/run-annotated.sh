#!/usr/bin/env bash
# Runs a command and keeps its output in the log as usual. On failure, the last
# lines of that output are repeated as a GitHub error annotation, and any
# "WARN ..." lines become warning annotations, so the reason shows up on the
# run's summary page without opening the log.
#
# Usage: scripts/run-annotated.sh <label> <command> [args...]
set -uo pipefail

label="${1:?usage: scripts/run-annotated.sh <label> <command> [args...]}"
shift
log="$(mktemp)"

"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

# Annotation messages are one line: escape % and encode newlines.
escape() { sed -e 's/%/%25/g' -e 's/\r/%0D/g' | awk 'BEGIN { ORS = "%0A" } { print }'; }

grep -E '^WARN ' "$log" | while IFS= read -r line; do
  echo "::warning title=${label}::$(printf '%s' "$line" | escape)"
done
if [ "$status" -ne 0 ]; then
  echo "::error title=${label} failed::$(tail -n 6 "$log" | escape)"
fi
rm -f "$log"
exit "$status"
