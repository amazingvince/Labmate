#!/usr/bin/env bash
# Labmate — read-only live smoke test.
#
# Verifies a deployed Labmate Worker (cockpit SPA + /api control plane + R2 dataset)
# is healthy and, crucially, whether the NEW code is live. It is strictly READ-ONLY:
# every request is a GET except a single deliberately-unauthenticated POST that we
# assert is REJECTED (401/503), so it never mutates the ledger.
#
# Usage:   ./scripts/verify_live.sh [BASE_URL]
#   BASE_URL defaults to https://labmate.amazingvince.com
#
# Exit code: 0 if every check PASSes, 1 if any check FAILs.
set -euo pipefail

BASE_URL="${1:-https://labmate.amazingvince.com}"
BASE_URL="${BASE_URL%/}"   # strip any trailing slash

# ---- tiny PASS/FAIL harness -------------------------------------------------
pass=0
fail=0
declare -a SUMMARY=()
NEW_CODE_LIVE="no"

ok()   { echo "  PASS  $1"; pass=$((pass + 1)); SUMMARY+=("PASS  $1"); }
bad()  { echo "  FAIL  $1"; fail=$((fail + 1)); SUMMARY+=("FAIL  $1"); }

# http_status URL [extra curl args...] -> echoes the HTTP status code (or 000)
http_status() {
  local url="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" "$url" 2>/dev/null || echo "000"
}

# requires python3 for robust JSON assertions
if ! command -v python3 >/dev/null 2>&1; then
  echo "verify_live.sh requires python3 for JSON assertions" >&2
  exit 1
fi

echo "Labmate live verification"
echo "========================="
echo "Target: $BASE_URL"
echo

# ---- 1) GET /api/studies -> 200 + body has a studies[] array ----------------
studies_body="$(curl -s --max-time 20 "$BASE_URL/api/studies" 2>/dev/null || true)"
studies_code="$(http_status "$BASE_URL/api/studies")"
if [ "$studies_code" = "200" ] && \
   printf '%s' "$studies_body" | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if isinstance(d.get("studies"),list) else 1)' 2>/dev/null; then
  count="$(printf '%s' "$studies_body" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["studies"]))' 2>/dev/null || echo '?')"
  ok "GET /api/studies -> 200, studies[] present ($count studies)"
else
  bad "GET /api/studies -> $studies_code (expected 200 with a studies[] array)"
fi

# ---- 2) GET /data/sla_tickets.csv -> 200 text/csv (proves R2 seeded) --------
csv_ct="$(curl -s -o /dev/null -w '%{content_type}' --max-time 20 "$BASE_URL/data/sla_tickets.csv" 2>/dev/null || echo '')"
csv_code="$(http_status "$BASE_URL/data/sla_tickets.csv")"
case "$csv_ct" in
  text/csv*) csv_ct_ok=1 ;;
  *)         csv_ct_ok=0 ;;
esac
if [ "$csv_code" = "200" ] && [ "$csv_ct_ok" = "1" ]; then
  ok "GET /data/sla_tickets.csv -> 200 text/csv (R2 dataset seeded)"
else
  bad "GET /data/sla_tickets.csv -> $csv_code ct='$csv_ct' (expected 200 text/csv — R2 dataset NOT seeded?)"
fi

# ---- pick the first study id for the per-study checks ------------------------
SID="$(printf '%s' "$studies_body" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); s=d.get("studies",[])
    print(s[0]["id"] if s else "")
except Exception:
    print("")' 2>/dev/null || echo '')"

if [ -z "$SID" ]; then
  bad "no study id available — skipping per-study checks (need at least one study)"
else
  echo "  ..   using study id: $SID"

  # ---- 3) GET /api/studies/{id} -> 200 with the ledger keys -----------------
  detail_body="$(curl -s --max-time 20 "$BASE_URL/api/studies/$SID" 2>/dev/null || true)"
  detail_code="$(http_status "$BASE_URL/api/studies/$SID")"
  if [ "$detail_code" = "200" ] && \
     printf '%s' "$detail_body" | python3 -c 'import sys,json
d=json.load(sys.stdin)
need={"study","hypotheses","runs","critiques","decisions"}
sys.exit(0 if need.issubset(d.keys()) else 1)' 2>/dev/null; then
    ok "GET /api/studies/{id} -> 200 (study/hypotheses/runs/critiques/decisions present)"
  else
    bad "GET /api/studies/{id} -> $detail_code (missing one of study/hypotheses/runs/critiques/decisions)"
  fi

  # ---- 4) GET /api/studies/{id}/report -> 200 ------------------------------
  report_code="$(http_status "$BASE_URL/api/studies/$SID/report")"
  if [ "$report_code" = "200" ]; then
    ok "GET /api/studies/{id}/report -> 200"
  else
    bad "GET /api/studies/{id}/report -> $report_code (expected 200)"
  fi

  # ---- 5) GET /api/studies/{id}/grade -> 200  *** NEW ROUTE ***--------------
  # On the OLD live deploy this route does not exist, so the router treats
  # "{id}/grade" as a study id and returns a MISLEADING not_found 404. A FAIL
  # here means the NEW code is not deployed yet — labelled exactly that way.
  grade_code="$(http_status "$BASE_URL/api/studies/$SID/grade")"
  if [ "$grade_code" = "200" ]; then
    ok "GET /api/studies/{id}/grade -> 200 (NEW route present)"
    NEW_CODE_LIVE="yes"
  else
    bad "GET /api/studies/{id}/grade -> $grade_code (NEW /grade route NOT deployed — old code is live; a 404 here is the misleading not_found from the old router)"
  fi

  # ---- 6) GET /api/studies/{id}/stream -> 200 text/event-stream ------------
  # An SSE stream never closes, so curl ALWAYS trips --max-time and exits 28 even
  # though the 200 + headers arrived first. We must NOT treat that exit as failure
  # and must NOT use `|| echo 000` (it would concatenate onto the captured status).
  # Capture status + content-type in one call to a tempfile; ignore the exit code.
  stream_meta="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 5 \
    "$BASE_URL/api/studies/$SID/stream" 2>/dev/null)" || true
  stream_code="${stream_meta%% *}"
  stream_ct="${stream_meta#* }"
  [ -n "$stream_code" ] || stream_code="000"
  case "$stream_ct" in
    text/event-stream*) stream_ct_ok=1 ;;
    *)                  stream_ct_ok=0 ;;
  esac
  if [ "$stream_code" = "200" ] && [ "$stream_ct_ok" = "1" ]; then
    ok "GET /api/studies/{id}/stream -> 200 text/event-stream (SSE; curl --max-time timeout is expected)"
  else
    bad "GET /api/studies/{id}/stream -> $stream_code ct='$stream_ct' (expected 200 text/event-stream)"
  fi
fi

# ---- 7) write WITHOUT a token must be rejected (401 or 503, never 200) -------
# Read-only assertion: we POST with NO Authorization header and require it to be
# refused. 503 = server token unset (writes_disabled); 401 = bad/missing token.
fb_code="$(http_status "$BASE_URL/api/feedback" -X POST -H 'content-type: application/json' -d '{"study_id":"_verify_no_token_","content":"verify_live read-only probe"}')"
if [ "$fb_code" = "401" ] || [ "$fb_code" = "503" ]; then
  ok "POST /api/feedback (no token) -> $fb_code (write correctly rejected)"
elif [ "$fb_code" = "200" ] || [ "$fb_code" = "201" ]; then
  bad "POST /api/feedback (no token) -> $fb_code (UNAUTHENTICATED WRITE ACCEPTED — security hole!)"
else
  bad "POST /api/feedback (no token) -> $fb_code (expected 401 or 503)"
fi

# ---- summary ----------------------------------------------------------------
echo
echo "Summary"
echo "-------"
for line in "${SUMMARY[@]}"; do
  echo "  $line"
done
echo
echo "  Total: $((pass + fail))   PASS: $pass   FAIL: $fail"
echo "  NEW CODE LIVE? $NEW_CODE_LIVE"
echo

if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
