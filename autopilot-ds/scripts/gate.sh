#!/usr/bin/env bash
# Stop-hook gate for one work stream.
#
#   exit 0  -> the stream's AUTOMATED criteria pass; Claude Code may stop.
#   exit 2  -> not yet; the Stop hook blocks and Claude keeps working. stderr
#              explains what's unmet (Claude reads it).
#
# Usage:  bash scripts/gate.sh backend   |   bash scripts/gate.sh ui
#
# Wire it as a Stop hook in each worktree's .claude/settings.json (see
# PARALLEL_BUILD.md). Exit code 2 is intentional — it is the code that makes a
# Stop hook keep the agent going. Running it by hand, a nonzero exit just means
# "criteria not met yet".
#
# NOTE: this gate is the FAST, deterministic floor. The backend's full live
# behavior is proven by tests/test_contract_e2e.py (run separately, with a key);
# the UI's visual criteria are confirmed against the mock. See the rubrics.

set -uo pipefail
STREAM="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "GATE: cannot cd to repo root" >&2; exit 2; }

fail() { echo "GATE FAILED ($STREAM): $1" >&2; exit 2; }

case "$STREAM" in
  backend)
    python -m py_compile backend/app.py backend/agent_config.py 2>/tmp/gate_pyc.err \
      || fail "backend files do not compile:
$(cat /tmp/gate_pyc.err)"
    python tests/check_backend.py \
      || fail "contract-surface check failed (see output above). The five endpoints, the State shape, the status vocabulary, the input guards (409/400/404), and the two custom tools must all be present."
    ;;
  ui)
    python tests/check_ui.py \
      || fail "UI conformance check failed (see output above). The UI must read /api/state, use all four command endpoints, render feed text safely, and wire a checkpoint modal with approve/reject."
    ;;
  *)
    echo "usage: bash scripts/gate.sh [backend|ui]" >&2
    exit 2
    ;;
esac

echo "GATE PASSED ($STREAM)"
exit 0
