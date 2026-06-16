#!/usr/bin/env bash
#
# Labmate — LOCAL full-stack end-to-end (NO Modal, NO deploy).
#
# Boots the whole stack on localhost and drives ONE real, agent-driven sla_tickets study
# to completion, then prints the rubric grade:
#
#   local runner shim (scripts/local_runner_shim.mjs)   <- stands in for the Modal runner
#   Cloudflare Worker (apps/web, `wrangler dev --local`) <- control plane + D1 + R2 (miniflare)
#   agent runtime     (apps/agent-runtime)               <- Managed Agents session = the LLM agent
#
# The LLM agent (Anthropic Managed Agents) does the profiling, hypotheses, launches,
# critiques, decision and report — we only POST the study brief + one business-feedback
# message, exactly as a human would in the cockpit.
#
# Requirements:
#   * Node + npm, and a populated repo-root .env with ANTHROPIC_API_KEY, LABMATE_AGENT_ID,
#     LABMATE_ENVIRONMENT_ID (run `npm run agent:bootstrap` once if the IDs are missing).
#   * For REAL=1 only: a python3 with pandas + scikit-learn (the agent's scripts run for real).
#
# Usage:
#   scripts/e2e_local.sh                 # MOCK runner (default) — fast, deterministic, no sklearn
#   REAL=1 scripts/e2e_local.sh          # REAL runner — agent scripts train on the real CSV
#   MODEL=claude-sonnet-4-6 scripts/e2e_local.sh   # agent model for the run (default sonnet, cheap)
#   UPDATE_AGENT=0 scripts/e2e_local.sh  # skip re-baking the agent model (use whatever it is now)
#
# Idempotent; kills every background process it starts on exit (trap).
set -euo pipefail

# --- locations -------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_ENV="${ROOT_ENV:-$REPO/.env}"   # may be overridden if .env lives outside the worktree

# Fall back to the shared checkout's .env if this worktree has none (the secret lives there).
if [ ! -f "$ROOT_ENV" ] && [ -f "/Users/vincent/Documents/code/Labmate/.env" ]; then
  ROOT_ENV="/Users/vincent/Documents/code/Labmate/.env"
fi

# --- config ----------------------------------------------------------------------------
WORKER_PORT="${WORKER_PORT:-8787}"
SHIM_PORT="${SHIM_PORT:-8899}"
RUNTIME_PORT="${RUNTIME_PORT:-8990}"
TOKEN="${TOKEN:-labmate-local-e2e-token-000000000000}"   # >= 24 chars (Worker writes_disabled guard)
MODEL="${MODEL:-claude-sonnet-4-6}"                       # cheap model for test runs
MAX_TRIALS="${MAX_TRIALS:-8}"
DEADLINE_S="${DEADLINE_S:-420}"
UPDATE_AGENT="${UPDATE_AGENT:-1}"
REAL="${REAL:-0}"

export PATH="$PATH"
PIDS=()
cleanup() {
  echo "--- cleanup: stopping background processes ---"
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f "local_runner_shim.mjs" 2>/dev/null || true
  pkill -f "agent-runtime/src/server.mjs" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- parse the colon-or-equals .env into export lines (values may contain ':' or '=') ---
RUNTIME_ENV="$(mktemp)"
chmod 600 "$RUNTIME_ENV"
node --input-type=module \
  -e "
import { readFileSync, writeFileSync } from 'node:fs';
const txt = readFileSync(process.argv[1], 'utf8');
const map = {};
for (const raw of txt.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('='); const colon = line.indexOf(':');
  const i = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
  if (i <= 0) continue;
  map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const ov = {
  LABMATE_PUBLIC_URL: process.argv[2],
  LABMATE_INTERNAL_TOKEN: process.argv[3],
  ANTHROPIC_MODEL: process.argv[4],
  AGENT_RUNTIME_PORT: process.argv[5],
  LABMATE_MAX_TOOL_CALLS: '60',
  LABMATE_MAX_SESSION_SECONDS: '600',
  LABMATE_DEFAULT_BUDGET_SECONDS: '600',
  LABMATE_DEFAULT_MAX_TRIALS: process.argv[6],
  LABMATE_APPROVAL_DELAY_MS: '1500',
  LABMATE_AUTO_APPROVE: 'true',
};
const out = { ...map, ...ov };
const keys = ['ANTHROPIC_API_KEY','LABMATE_AGENT_ID','LABMATE_ENVIRONMENT_ID','LABMATE_PUBLIC_URL','LABMATE_INTERNAL_TOKEN','ANTHROPIC_MODEL','AGENT_RUNTIME_PORT','LABMATE_MAX_TOOL_CALLS','LABMATE_MAX_SESSION_SECONDS','LABMATE_DEFAULT_BUDGET_SECONDS','LABMATE_DEFAULT_MAX_TRIALS','LABMATE_APPROVAL_DELAY_MS','LABMATE_AUTO_APPROVE'];
const lines = keys.filter(k => out[k] !== undefined && out[k] !== '').map(k => 'export ' + k + '=' + JSON.stringify(out[k]));
writeFileSync(process.argv[7], lines.join('\n') + '\n');
" "$ROOT_ENV" "http://127.0.0.1:${WORKER_PORT}" "$TOKEN" "$MODEL" "$RUNTIME_PORT" "$MAX_TRIALS" "$RUNTIME_ENV"

# shellcheck disable=SC1090
set -a; . "$RUNTIME_ENV"; set +a

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "ERROR: ANTHROPIC_API_KEY not found in $ROOT_ENV" >&2; exit 1; fi
if [ -z "${LABMATE_AGENT_ID:-}" ] || [ -z "${LABMATE_ENVIRONMENT_ID:-}" ]; then
  echo "ERROR: LABMATE_AGENT_ID / LABMATE_ENVIRONMENT_ID missing — run 'npm run agent:bootstrap' once." >&2; exit 1
fi
echo "config: model=$ANTHROPIC_MODEL agent=${LABMATE_AGENT_ID:0:10} runner=$([ "$REAL" = 1 ] && echo REAL || echo MOCK) max_trials=$MAX_TRIALS"

# --- deps (fast no-ops if already installed) -------------------------------------------
( cd "$REPO" && npm install --no-audit --no-fund >/dev/null 2>&1 || true )
( cd "$REPO/apps/web" && npm install --no-audit --no-fund >/dev/null 2>&1 || true )

# --- the Worker's [assets] dir must exist (cockpit SPA). Placeholder for API-only e2e. --
mkdir -p "$REPO/apps/cockpit/dist"
[ -f "$REPO/apps/cockpit/dist/index.html" ] || \
  printf '<!doctype html><title>Labmate local e2e</title><p>API-only mode.</p>\n' > "$REPO/apps/cockpit/dist/index.html"

# --- .dev.vars for the Worker (gitignored; points everything at localhost) -------------
cat > "$REPO/apps/web/.dev.vars" <<EOF
LABMATE_INTERNAL_TOKEN = "${TOKEN}"
MODAL_RUNNER_URL = "http://127.0.0.1:${SHIM_PORT}"
AGENT_RUNTIME_URL = "http://127.0.0.1:${RUNTIME_PORT}"
LABMATE_DATASET_BASE = "http://127.0.0.1:${WORKER_PORT}/data"
EOF

# --- 1) runner shim --------------------------------------------------------------------
echo "--- starting local runner shim ($([ "$REAL" = 1 ] && echo REAL || echo MOCK)) on :$SHIM_PORT ---"
if [ "$REAL" = 1 ]; then export REAL=1; else unset REAL || true; fi
PORT="$SHIM_PORT" node "$REPO/scripts/local_runner_shim.mjs" > /tmp/labmate_shim.log 2>&1 &
PIDS+=($!)

# --- 2) Worker (wrangler dev, local miniflare) -----------------------------------------
echo "--- starting Worker (wrangler dev --local) on :$WORKER_PORT ---"
( cd "$REPO/apps/web" && WRANGLER_SEND_METRICS=false npx wrangler dev --port "$WORKER_PORT" --local \
    --persist-to .wrangler/state > /tmp/labmate_wrangler.log 2>&1 ) &
PIDS+=($!)

echo -n "    waiting for Worker"
for _ in $(seq 1 60); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WORKER_PORT}/api/studies" 2>/dev/null | grep -q 200; then
    echo " — ready"; break; fi
  echo -n "."; sleep 1
done

# --- seed the golden dataset into local R2 (so REAL mode + /data route can read it) ----
( cd "$REPO/apps/web" && WRANGLER_SEND_METRICS=false npx wrangler r2 object put \
    labmate-artifacts/datasets/sla_tickets.csv --file="$REPO/examples/sla_tickets/data.csv" \
    --local --persist-to .wrangler/state > /tmp/labmate_seed.log 2>&1 ) || true

# --- 3) agent runtime ------------------------------------------------------------------
# Optionally re-bake the agent onto the chosen (cheap) model. Idempotent; live call.
if [ "$UPDATE_AGENT" = 1 ]; then
  echo "--- updating agent model -> $MODEL (idempotent) ---"
  ( cd "$REPO/apps/agent-runtime" && node src/bootstrap.mjs --update > /tmp/labmate_bootstrap.log 2>&1 ) || \
    echo "    (agent update skipped/failed — see /tmp/labmate_bootstrap.log; continuing)"
fi
echo "--- starting agent runtime on :$RUNTIME_PORT ---"
( cd "$REPO/apps/agent-runtime" && node src/server.mjs > /tmp/labmate_runtime.log 2>&1 ) &
PIDS+=($!)
echo -n "    waiting for runtime"
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${RUNTIME_PORT}/healthz" 2>/dev/null | grep -q 200; then
    echo " — ready"; break; fi
  echo -n "."; sleep 1
done

# --- 4) drive a real agent study + grade ----------------------------------------------
echo "--- driving the study (agent-driven; this calls the Anthropic Managed Agents API) ---"
CONTROL_PLANE="http://127.0.0.1:${WORKER_PORT}" TOKEN="$TOKEN" MAX_TRIALS="$MAX_TRIALS" DEADLINE_S="$DEADLINE_S" \
  node "$REPO/scripts/e2e_local_driver.mjs"
RC=$?

rm -f "$RUNTIME_ENV"
echo "--- done (driver exit $RC). Logs: /tmp/labmate_{shim,wrangler,runtime}.log ---"
exit $RC
