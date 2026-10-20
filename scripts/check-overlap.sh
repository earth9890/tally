#!/bin/sh
# Fails if segments overlap — the signature of concurrent ticks double-booking
# wall-clock time. Run after any change to tracker.js timing/flush logic.
#   sh scripts/check-overlap.sh [hours_back]   (default 2)
set -e
DB="$HOME/Library/Application Support/Tally/desktime.db"
H="${1:-2}"
SNAP="$(mktemp -t tally-check).db"
sqlite3 "$DB" ".backup '$SNAP'"

sqlite3 "$SNAP" "
WITH s AS (
  SELECT start_ts, end_ts, LAG(end_ts) OVER (ORDER BY start_ts, id) prev_end
  FROM segments
  WHERE start_ts >= (strftime('%s','now') - $H*3600) * 1000
)
SELECT COUNT(*), COALESCE(SUM(prev_end - start_ts), 0)
FROM s WHERE prev_end IS NOT NULL AND start_ts < prev_end;
" | awk -F'|' -v h="$H" '
{
  if ($1 > 0) {
    printf "FAIL: %d overlapping segments in the last %sh (%.1f min double-booked)\n", $1, h, $2/60000
    exit 1
  }
  printf "OK: no overlapping segments in the last %sh\n", h
}'
rc=$?
rm -f "$SNAP"
exit $rc
