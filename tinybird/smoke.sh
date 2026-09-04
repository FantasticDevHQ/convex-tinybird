#!/usr/bin/env bash
#
# Prove the dedupe contract against a real ClickHouse, not a mental model.
#
# Sends the SAME event three times and asserts the pipe still counts it once. That is the whole
# claim the component's at-least-once delivery rests on, and nothing in the TypeScript test
# suite can check it — the behaviour lives in the engine, not in our code.
#
# Not run in CI: it needs Docker and pulls an image. Run it by hand when the datasource or the
# pipe changes, and paste the output into the pull request.
#
#   ./tinybird/smoke.sh
set -euo pipefail

cd "$(dirname "$0")"
PORT="${TB_LOCAL_PORT:-7181}"
CONTAINER="tinybird-local-smoke"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting Tinybird Local on :${PORT}"
cleanup
docker run -d --rm --name "$CONTAINER" -p "${PORT}:7181" tinybirdco/tinybird-local:latest >/dev/null

echo "==> waiting for it to answer"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${PORT}/v0/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

# Tinybird Local publishes its admin token on an unauthenticated `/tokens` endpoint. The `tb`
# CLI cannot be used to discover it here: `tb token ls` needs a token to run.
TOKEN="$(curl -fsS "http://localhost:${PORT}/tokens" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["admin_token"])' 2>/dev/null || echo "")"
if [ -z "$TOKEN" ]; then
  echo "could not read an admin token from the container; is the image up?" >&2
  exit 1
fi

echo "==> deploying the datasource and pipe"
# `deploy`, not `build`. `tb build` produces an ephemeral build that the workspace's own
# endpoints cannot see — the datasource list stays empty and every ingest returns 404, which
# looks like a broken script rather than the wrong verb.
tb --host "http://localhost:${PORT}" --token "$TOKEN" deploy

# One row count off the deployed table. Used by the poll and by the control assertion, so both
# ask the storage layer the same question the same way.
raw_count() {
  tb --host "http://localhost:${PORT}" --token "$TOKEN" \
    sql "SELECT count() AS raw FROM events" 2>/dev/null \
    | grep -oE '^\s+[0-9]+\s*$' | tr -d ' ' | head -1
}

echo "==> sending the SAME event three times"
ROW='{"event_id":"evt_smoke_1","event_type":"order_created","occurred_at":"2026-09-05 10:00:00.000","version":1,"payload":"{\"sku\":\"SKU-1\"}"}'
for _ in 1 2 3; do
  curl -fsS -X POST "http://localhost:${PORT}/v0/events?name=events" \
    -H "Authorization: Bearer ${TOKEN}" -d "$ROW" >/dev/null
done

# Wait for the value we expect rather than for a duration. `sleep 2` read a PARTIALLY INGESTED
# table and saw 2 rows, which was then written up as background merges collapsing a duplicate.
# It was not: waiting LONGER makes the number go UP (measured — 2s gives 2, 30s gives 3), and no
# merge can do that. The two look identical in a single sample and are told apart by direction,
# so poll for 3 instead of guessing a duration, and let the deadline be the thing that reports.
DEADLINE=$((SECONDS + 60))
while :; do
  RAW="$(raw_count)"
  [ "${RAW:-0}" -ge 3 ] && break
  [ "$SECONDS" -ge "$DEADLINE" ] && break
  sleep 1
done

echo "==> querying the pipe"
COUNT="$(curl -fsS "http://localhost:${PORT}/v0/pipes/events_by_type.json" \
  -H "Authorization: Bearer ${TOKEN}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(r["events"] for r in d["data"]))')"

echo "sent 3, raw rows ${RAW}, pipe counted ${COUNT}"
# The CONTROL, and the reason this script is evidence rather than a green light. If the engine
# had already collapsed the duplicates on disk, the pipe would return 1 whether or not it said
# FINAL. Reading the raw count is what makes the pass mean something: three rows PHYSICALLY
# STORED and one row returned can only be read-time dedupe.
#
# Exactly 3, not "at least 2". The looser bound was never needed — it was added to accommodate a
# 2 that came from reading too early, not from merges. With the poll above, anything short of 3
# is either a merge that beat us or an ingest that never landed, and neither exercises FINAL, so
# neither should be reported as a pass.
if [ "${RAW:-0}" -ne 3 ]; then
  echo "INCONCLUSIVE: raw rows ${RAW}, expected 3 — either ingest never landed within 60s or a" >&2
  echo "merge collapsed the duplicates first. FINAL was not exercised, so this run proves" >&2
  echo "nothing. Re-run; this is timing, not a defect." >&2
  exit 1
fi
if [ "$COUNT" != "1" ]; then
  echo "FAILED: expected 1, got ${COUNT} — dedupe is not holding" >&2
  exit 1
fi
echo "PASS: duplicates stored (${RAW} raw rows) and counted once by the pipe"
