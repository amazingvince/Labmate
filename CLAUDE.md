# CLAUDE.md — project context for Claude Code

**Autopilot DS**: a guidable autonomous data scientist. You set a goal; Claude
[Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) runs an
experiment loop (hypothesize → train → log → review), surfaces results on a live
leaderboard in a web UI, and pauses at checkpoints for a human to approve or redirect.
The signature moment: the agent catches a data leak in its own model and asks before
shipping it.

## The one hard rule
`API_CONTRACT.md` is the **frozen interface** between the two work streams. Do **not**
edit it. If you believe it must change, **stop and ask the human** — both streams
depend on it staying stable.

## Where everything is
- `API_CONTRACT.md` — the five endpoints + the polled `State` object (source of truth)
- `BACKLOG_backend.md` / `BACKLOG_ui.md` — the two streams' tickets, in order
- `rubrics/RUBRIC_backend.md` / `rubrics/RUBRIC_ui.md` — how each stream is graded
- `PARALLEL_BUILD.md` — how to run both streams in parallel + the `/goal` prompts
- `DEPLOY.md` — shipping to a live URL
- `GETTING_STARTED.md` — the runbook (start here)

## Scope (do not cross streams)
- **Backend stream** edits only `backend/` and `tests/`.
- **UI stream** edits only `frontend/`.
- Build/verify the UI against `mock_backend.py` (no API key, no token cost).

## How to check your own work (don't claim done — prove it)
- Backend: `bash scripts/gate.sh backend` must exit 0, **and** with a running backend
  `python tests/test_contract_e2e.py http://localhost:8000` must exit 0.
- UI: `bash scripts/gate.sh ui` must exit 0, and the gating visual rows in the rubric
  must render correctly against the mock (load it and click through).

## Don't
- Don't commit `ANTHROPIC_API_KEY` or any secret (the repo is public).
- Don't run the backend with more than one worker (`gunicorn -w 1`): state + the
  agent-session thread live in one process. See `DEPLOY.md`.
