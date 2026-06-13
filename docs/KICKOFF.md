# Kickoff — paste this into Claude Code first

Open Claude Code in the repo root, then paste the block below. It briefs the model,
points it at the contracts, and hands off to the `/goal`.

---

```
You are building Labmate, an agent-native data science harness. Read these first,
in order, and treat them as the source of truth:

  - docs/BRIEF.md        (what we're building and why; the wedge vs AutoML)
  - docs/RUBRIC.md + docs/rubric.json   (definition of done; you will grade yourself against this)
  - docs/GOALS.md        (the /goal and non-goals)
  - docs/BUILD_PLAN.md   (the hour-by-hour plan for today)
  - CLAUDE.md            (build/test commands, conventions, contracts)

The architecture, repo layout, and the four subagents (ds-planner, experiment-runner,
experiment-critic, report-writer) and four skills (tabular-ds-protocol, leakage-review,
optuna-search, model-card) are already scaffolded under .claude/. The semantic MCP tool
layer is in apps/mcp-server, the Cloudflare control plane in apps/web, and the fixed
Modal runner in apps/modal-runner. The golden-path dataset is examples/sla_tickets.

Rules of engagement:
  1. The human steers the SCIENCE via business feedback; you steer the code. Do not ask
     the human to write training scripts.
  2. Never train before a leakage review. Always create a deterministic split first and
     always run a baseline.
  3. Compute launches and any destructive action require human approval (hooks enforce
     this — do not try to bypass them).
  4. Every run must be linked to a hypothesis and carry your rationale. Every decision
     (promote/reject/rerun) must be recorded.
  5. Stay inside the non-goals in docs/GOALS.md.

Start by confirming the scaffold builds (run ./scripts/preflight.sh), then fill in the
TODOs in apps/* and .claude/workflows/run-study.js so the golden path runs. When the
plumbing is in place, execute the headline goal below.
```

Then paste the headline `/goal` from `docs/GOALS.md`.

---

## If something is missing a key

`./scripts/preflight.sh` tells you which keys / CLIs are missing. Fill `.env`
(see `docs/ENV.md`) and rerun. Don't ask Claude to invent credentials.

## The judges' moment

Make sure the session log captures the instant the critic catches the planted
test-set-tuning bug and reruns the corrected experiment. That single moment is your
strongest evidence under both Demo (35%) and Orchestration (15%). See `docs/DEMO_SCRIPT.md`.
