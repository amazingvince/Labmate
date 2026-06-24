#!/usr/bin/env bash
# Labmate — one-command deploy of the Cloudflare control plane.
#
# Ships the single Worker that serves BOTH the cockpit SPA (Workers Static Assets,
# from apps/cockpit/dist) AND the /api control plane, bound to two hostnames per
# apps/web/wrangler.toml:
#   - amazingvince.com/*            (apex zone route over existing DNS)
#   - labmate.amazingvince.com      (custom_domain, wrangler-managed DNS+TLS)
# Bindings: D1 "labmate" (binding DB), R2 "labmate-artifacts" (binding ARTIFACTS),
# Durable Object STUDY; vars MODAL_RUNNER_URL, AGENT_RUNTIME_URL, LABMATE_DATASET_BASE.
#
# This script is idempotent and fail-fast. It deliberately does NOT deploy the two
# Modal apps or rotate cloud keys (those need `modal` + live tokens); it prints those
# manual steps (step 7) and then runs the read-only verifier (step 8).
#
# Usage:
#   ./scripts/deploy.sh              # deploy for real
#   ./scripts/deploy.sh --dry-run    # print every command without running it
#
# Env knobs:
#   LABMATE_INTERNAL_TOKEN   server write token (>=24 chars). Auto-generated if unset.
#   VERIFY_TARGET            base URL the verifier hits (default labmate.amazingvince.com)
#   ANTHROPIC_API_KEY,
#   MODAL_TOKEN_ID/SECRET    only warned about — needed for the Modal apps, not this deploy.
set -euo pipefail

# ---- locate the repo root (this script lives in scripts/) -------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
cd "$REPO_ROOT"

# ---- flags ------------------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg (use --dry-run or --help)" >&2; exit 2 ;;
  esac
done

# Default verify target: the custom-domain host (also reachable via the apex route).
VERIFY_TARGET="${VERIFY_TARGET:-https://labmate.amazingvince.com}"

# ---- helpers ----------------------------------------------------------------
step()  { echo; echo "==> $1"; }
info()  { echo "    $1"; }
warn()  { echo "    WARN: $1" >&2; }
die()   { echo "    ERROR: $1" >&2; exit 1; }

# run CMD...  — echoes the command; runs it unless --dry-run.
run() {
  echo "    \$ $*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

# wrangler — always invoke the repo's pinned wrangler via npx, from apps/web so it
# reads apps/web/wrangler.toml. Caller must `cd apps/web` first (we do, per step).
WRANGLER=(npx --yes wrangler)

echo "Labmate deploy"
echo "=============="
[ "$DRY_RUN" -eq 1 ] && echo "(dry-run — commands are printed, not executed)"
echo "Repo: $REPO_ROOT"

# =============================================================================
# 1) Preflight: tooling + the write token
# =============================================================================
step "1/8  Preflight: tooling + write token"

command -v node >/dev/null 2>&1 || die "node not found (need Node 18+). Install Node, then re-run."
info "node $(node -v)"
command -v npx  >/dev/null 2>&1 || die "npx not found (ships with Node/npm)."
# Surface the pinned wrangler version (best-effort; never fatal).
if [ "$DRY_RUN" -eq 0 ]; then
  wv="$("${WRANGLER[@]}" --version 2>/dev/null | tail -n1 || echo 'unknown')"
  info "wrangler: $wv"
else
  info "wrangler: (skipped in dry-run)"
fi

# LABMATE_INTERNAL_TOKEN — the server-side write token. Reads are public; writes
# require this. The Worker REFUSES writes (503 writes_disabled) if it is <24 chars,
# so we enforce >=24 here and generate one if unset.
if [ -z "${LABMATE_INTERNAL_TOKEN:-}" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    die "LABMATE_INTERNAL_TOKEN is unset and openssl is not available to generate one. Export a >=24-char token and re-run."
  fi
  LABMATE_INTERNAL_TOKEN="$(openssl rand -hex 24)"   # 48 hex chars
  export LABMATE_INTERNAL_TOKEN
  warn "LABMATE_INTERNAL_TOKEN was unset — generated a fresh one for this deploy."
  warn "SAVE IT NOW (it will be set as the Worker secret and is NOT printed again):"
  # Print ONCE so the operator can store it; this is a freshly-minted value, not a
  # committed secret. It is needed to drive writes / a writeable demo later.
  echo "    LABMATE_INTERNAL_TOKEN=$LABMATE_INTERNAL_TOKEN"
elif [ "${#LABMATE_INTERNAL_TOKEN}" -lt 24 ]; then
  die "LABMATE_INTERNAL_TOKEN is set but only ${#LABMATE_INTERNAL_TOKEN} chars; the Worker disables writes below 24. Use a longer token (e.g. openssl rand -hex 24)."
else
  info "LABMATE_INTERNAL_TOKEN present (${#LABMATE_INTERNAL_TOKEN} chars) — OK."
fi

# These are NOT needed to deploy the Worker — only to deploy/run the Modal apps and
# the agent runtime. Warn, do not fail.
[ -n "${ANTHROPIC_API_KEY:-}" ] || warn "ANTHROPIC_API_KEY unset — fine for the Worker; needed by the agent-runtime Modal app (step 7)."
[ -n "${MODAL_TOKEN_ID:-}" ] && [ -n "${MODAL_TOKEN_SECRET:-}" ] || \
  warn "MODAL_TOKEN_ID/MODAL_TOKEN_SECRET unset — fine for the Worker; needed to deploy the Modal runner + agent-runtime (step 7)."

# =============================================================================
# 2) Build the cockpit SPA  (emits apps/cockpit/dist -> served as Worker assets)
# =============================================================================
step "2/8  Build cockpit SPA (apps/cockpit -> dist)"
# VITE_API_BASE empty  => SPA calls /api SAME-ORIGIN (works on both hostnames).
# VITE_API_TOKEN blank => PUBLIC, READ-ONLY bundle: no write token shipped to the
#   browser. For an interactive (writeable) demo, bake a SCOPED token by exporting
#   VITE_API_TOKEN=<token-matching-the-Worker-secret> before this step — it then
#   ships in the JS bundle, so only use a token you are comfortable making public.
info "VITE_API_BASE='' (same-origin), VITE_API_TOKEN='${VITE_API_TOKEN:-}' (blank = read-only public bundle)"
run env -C "$REPO_ROOT/apps/cockpit" VITE_API_BASE="" VITE_API_TOKEN="${VITE_API_TOKEN:-}" npm ci
run env -C "$REPO_ROOT/apps/cockpit" VITE_API_BASE="" VITE_API_TOKEN="${VITE_API_TOKEN:-}" npm run build
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$REPO_ROOT/apps/cockpit/dist/index.html" ]; then
  die "cockpit build did not produce apps/cockpit/dist/index.html — the Worker has no assets to serve."
fi
info "cockpit dist ready (apps/cockpit/dist)"

# From here on, wrangler must run inside apps/web so it reads apps/web/wrangler.toml.
cd "$REPO_ROOT/apps/web"

# =============================================================================
# 3) Apply the D1 schema (remote)
# =============================================================================
step "3/8  Apply D1 schema to 'labmate' (remote)"
info "The Worker also self-applies schema on first request; we do it explicitly so a"
info "fresh DB is ready before the first write."
run "${WRANGLER[@]}" d1 execute labmate --file=schema.sql --remote --yes

# =============================================================================
# 4) Seed the dataset into R2  (the reproducibility gap — made explicit)
# =============================================================================
step "4/8  Seed dataset into R2 (labmate-artifacts/datasets/sla_tickets.csv)"
info "The Modal runner + the cockpit fetch the CSV from /data/sla_tickets.csv, which"
info "the Worker serves from R2 key datasets/sla_tickets.csv. wrangler deploy does NOT"
info "upload data — this step is what makes the live study reproducible."
DATA_CSV="$REPO_ROOT/examples/sla_tickets/data.csv"
[ -f "$DATA_CSV" ] || die "dataset missing at $DATA_CSV — run: python3 scripts/gen_dataset.py"
run "${WRANGLER[@]}" r2 object put labmate-artifacts/datasets/sla_tickets.csv \
  --file="$DATA_CSV" --content-type="text/csv" --remote
# Verify the object is really there.
if [ "$DRY_RUN" -eq 0 ]; then
  if "${WRANGLER[@]}" r2 object get labmate-artifacts/datasets/sla_tickets.csv --remote --file=/dev/null >/dev/null 2>&1; then
    info "verified: datasets/sla_tickets.csv present in R2."
  else
    warn "could not verify the R2 object via 'r2 object get' — confirm /data/sla_tickets.csv after deploy (the verifier checks this)."
  fi
else
  info "(dry-run) would verify the R2 object with: ${WRANGLER[*]} r2 object get labmate-artifacts/datasets/sla_tickets.csv --remote"
fi

# =============================================================================
# 5) Set the write secret
# =============================================================================
step "5/8  Set LABMATE_INTERNAL_TOKEN as a Worker secret"
info "Reads stay public; this secret gates writes (POST /api/*). For a WRITEABLE demo"
info "the cockpit's VITE_API_TOKEN (step 2) must equal this value."
if [ "$DRY_RUN" -eq 0 ]; then
  printf '%s' "$LABMATE_INTERNAL_TOKEN" | "${WRANGLER[@]}" secret put LABMATE_INTERNAL_TOKEN
else
  echo "    \$ printf '%s' \"\$LABMATE_INTERNAL_TOKEN\" | ${WRANGLER[*]} secret put LABMATE_INTERNAL_TOKEN"
fi

# =============================================================================
# 6) Deploy the Worker
# =============================================================================
step "6/8  Deploy the Worker (cockpit assets + /api, both hostnames)"
run "${WRANGLER[@]}" deploy

# =============================================================================
# 7) MANUAL steps this script deliberately does NOT do
# =============================================================================
step "7/8  MANUAL follow-ups (need modal CLI + live tokens — NOT done here)"
cat <<'MANUAL'
    These require `pip install modal` and authenticated Modal/Anthropic tokens, so
    they are intentionally left to a human:

    a) Deploy the Modal experiment runner (sandboxed training jobs):
         pip install modal
         modal deploy apps/modal-runner/runner.py
       -> note the deployed URL and ensure the Worker var MODAL_RUNNER_URL points at it
          (apps/web/wrangler.toml [vars] MODAL_RUNNER_URL=...; redeploy if changed).

    b) Deploy the managed agent runtime (drives the autonomous study loop):
         modal deploy apps/agent-runtime/modal_app.py
       -> ensure the Worker var AGENT_RUNTIME_URL points at its deployed URL
          (apps/web/wrangler.toml [vars] AGENT_RUNTIME_URL=...; redeploy if changed).

    c) Rotate / set cloud keys used by the Modal apps (NOT the Worker):
         - ANTHROPIC_API_KEY  (agent-runtime: planning, leakage critique, NL->constraints)
         - MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (Modal auth)
       Rotate these on the Modal side (modal secret / env), never commit them.
MANUAL

# =============================================================================
# 8) Read-only verification
# =============================================================================
step "8/8  Verify the live deploy (read-only)"
if [ "$DRY_RUN" -eq 0 ]; then
  run bash "$SCRIPT_DIR/verify_live.sh" "$VERIFY_TARGET"
else
  echo "    \$ bash $SCRIPT_DIR/verify_live.sh $VERIFY_TARGET"
fi

echo
echo "Done."
