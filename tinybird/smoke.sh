#!/usr/bin/env bash
# Verify duplicate-safe reads and result limits against disposable Tinybird Local.
set -euo pipefail
cd "$(dirname "$0")"
PORT=7181
CONTAINER="tinybird-local-smoke-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting Tinybird Local on :${PORT}"
docker run -d --rm --name "$CONTAINER" -p "${PORT}:7181" tinybirdco/tinybird-local:latest >/dev/null
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${PORT}/v0/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
TOKEN="$(curl -fsS "http://localhost:${PORT}/tokens" | python3 -c 'import json,sys; print(json.load(sys.stdin)["admin_token"])')"
tb --host "http://localhost:${PORT}" --token "$TOKEN" deploy | sed -E 's/token=[^[:space:]]+/token=[redacted]/g'

query() {
  curl -fsSG "http://localhost:${PORT}/v0/sql" \
    -H "Authorization: Bearer ${TOKEN}" --data-urlencode "q=$1 FORMAT JSON"
}
raw_count() {
  query "SELECT count() AS raw FROM events" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["raw"])'
}
pipe_rows() {
  curl -fsS "http://localhost:${PORT}/v0/pipes/events_by_type.json$1" \
    -H "Authorization: Bearer ${TOKEN}"
}

for _ in 1 2 3; do
  curl -fsS -X POST "http://localhost:${PORT}/v0/events?name=events&wait=true" \
    -H "Authorization: Bearer ${TOKEN}" --data-binary @fixtures/event.ndjson >/dev/null
done
DEADLINE=$((SECONDS + 60))
while :; do
  RAW="$(raw_count)"
  [ "$RAW" -ge 3 ] && break
  [ "$SECONDS" -ge "$DEADLINE" ] && break
  sleep 1
done
COUNT="$(pipe_rows '' | python3 -c 'import json,sys; print(sum(r["events"] for r in json.load(sys.stdin)["data"]))')"
echo "sent 3, raw rows ${RAW}, pipe counted ${COUNT}"
if [ "$RAW" -ne 3 ]; then
  echo "INCONCLUSIVE: expected 3 raw rows before background merges; retry the smoke test" >&2
  exit 1
fi
[ "$COUNT" = 1 ] || { echo "FAILED: duplicate count ${COUNT}" >&2; exit 1; }
echo "PASS: duplicates stored (${RAW} raw rows) and counted once by the pipe"

# More groups than the maximum, so removing the cap fails this assertion.
python3 - <<'PY' | curl -fsS -X POST "http://localhost:${PORT}/v0/events?name=events&wait=true" \
  -H "Authorization: Bearer ${TOKEN}" --data-binary @- >/dev/null
import json
for i in range(1001):
    print(json.dumps({"event_id": f"limit_{i}", "event_type": f"type_{i:04}", "occurred_at": "2026-09-05 10:00:00.000", "payload": "{}"}))
PY
DEADLINE=$((SECONDS + 60))
while :; do
  GROUPS_READY="$(query 'SELECT uniqExact(event_type) AS groups FROM events' | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["groups"])')"
  [ "$GROUPS_READY" -eq 1002 ] && break
  [ "$SECONDS" -ge "$DEADLINE" ] && { echo "FAILED: limit fixtures did not ingest" >&2; exit 1; }
  sleep 1
done
for CASE in default:100 99999:1000 1:1 0:1 -1:1; do
  LIMIT_VALUE="${CASE%:*}"
  EXPECTED="${CASE#*:}"
  PARAM="?limit=${LIMIT_VALUE}"
  [ "$LIMIT_VALUE" != default ] || PARAM=''
  ACTUAL="$(pipe_rows "$PARAM" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))')"
  [ "$ACTUAL" -eq "$EXPECTED" ] || { echo "FAILED: limit=${LIMIT_VALUE} returned ${ACTUAL}, expected ${EXPECTED}" >&2; exit 1; }
  echo "PASS: limit=${LIMIT_VALUE} returns ${ACTUAL} groups"
done
