#!/usr/bin/env bash
# Labmate preflight — run before you start the build. Checks tooling and .env keys.
# Usage: ./scripts/preflight.sh
set -uo pipefail

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
warn() { echo "  ⚠️  $1"; }

echo "Labmate preflight"
echo "================="

echo "Tooling:"
command -v node    >/dev/null 2>&1 && ok "node $(node -v)"            || bad "node not found (need Node 18+)"
command -v npm     >/dev/null 2>&1 && ok "npm $(npm -v)"              || bad "npm not found"
command -v python3 >/dev/null 2>&1 && ok "python3 $(python3 -V 2>&1 | awk '{print $2}')" || bad "python3 not found"
command -v pip3    >/dev/null 2>&1 && ok "pip3 present"               || warn "pip3 not found (needed for Modal/data deps)"
command -v npx     >/dev/null 2>&1 && ok "npx present (wrangler via npx)" || warn "npx not found"
command -v modal   >/dev/null 2>&1 && ok "modal CLI present"          || warn "modal CLI not found — 'pip install modal' then 'modal token new'"

echo "Env (.env):"
if [ -f .env ]; then
  ok ".env exists"
  # shellcheck disable=SC1091
  set -a; . ./.env 2>/dev/null; set +a
  check_key() { if [ -n "${!1:-}" ]; then ok "$1 set"; else bad "$1 missing"; fi; }
  check_key ANTHROPIC_API_KEY
  check_key ANTHROPIC_MODEL
  check_key MODAL_TOKEN_ID
  check_key MODAL_TOKEN_SECRET
  check_key MODAL_RUNNER_URL
  check_key CLOUDFLARE_ACCOUNT_ID
  check_key CLOUDFLARE_API_TOKEN
  check_key CLOUDFLARE_D1_DATABASE_ID
  check_key LABMATE_INTERNAL_TOKEN
  [ -n "${LABMATE_PUBLIC_URL:-}" ] && ok "LABMATE_PUBLIC_URL set" || warn "LABMATE_PUBLIC_URL not set yet (set after first wrangler deploy)"
else
  bad ".env not found — run: cp .env.example .env  then fill it in (see docs/ENV.md)"
fi

echo "Dataset:"
if [ -f examples/sla_tickets/data.csv ]; then
  ok "examples/sla_tickets/data.csv present ($(wc -l < examples/sla_tickets/data.csv) lines)"
else
  warn "dataset missing — run: python3 scripts/gen_dataset.py"
fi

# The deployed Worker must serve the dataset from R2 at /data/sla_tickets.csv (the
# runner fetches it from there). This is a separate step from `wrangler deploy` —
# upload it with: wrangler r2 object put labmate-artifacts/datasets/sla_tickets.csv
#   --file examples/sla_tickets/data.csv   (see HOWTO.md §3).
if [ -n "${LABMATE_PUBLIC_URL:-}" ]; then
  if echo "$LABMATE_PUBLIC_URL" | grep -Eq '127\.0\.0\.1|localhost|0\.0\.0\.0'; then
    warn "LABMATE_PUBLIC_URL is local — skipping the /data/sla_tickets.csv reachability check"
  elif command -v curl >/dev/null 2>&1; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${LABMATE_PUBLIC_URL%/}/data/sla_tickets.csv" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
      ok "GET \$LABMATE_PUBLIC_URL/data/sla_tickets.csv -> 200 (R2 dataset uploaded)"
    else
      warn "GET \$LABMATE_PUBLIC_URL/data/sla_tickets.csv -> $code — upload it: wrangler r2 object put labmate-artifacts/datasets/sla_tickets.csv --file examples/sla_tickets/data.csv (HOWTO.md §3)"
    fi
  else
    warn "curl not found — cannot check /data/sla_tickets.csv reachability"
  fi
else
  warn "LABMATE_PUBLIC_URL not set — skipping the /data/sla_tickets.csv reachability check (run after deploy + R2 upload)"
fi

echo "Scaffold:"
[ -f CLAUDE.md ] && ok "CLAUDE.md" || bad "CLAUDE.md missing"
[ -f docs/rubric.json ] && ok "docs/rubric.json" || bad "docs/rubric.json missing"
[ -d .claude/agents ] && ok ".claude/agents" || bad ".claude/agents missing"
[ -d .claude/skills ] && ok ".claude/skills" || bad ".claude/skills missing"
[ -f .claude/workflows/run-study.js ] && ok ".claude/workflows/run-study.js" || bad "run-study.js missing"

echo "================="
echo "Passed: $pass   Failed: $fail"
if [ "$fail" -gt 0 ]; then
  echo "Fix the ❌ items above before kicking off. See docs/ENV.md."
  exit 1
fi
echo "Preflight green. Open Claude Code and paste docs/KICKOFF.md."
