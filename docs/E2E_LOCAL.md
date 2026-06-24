# Local end-to-end (no Modal)

Prove the **whole agent loop** runs locally — the LLM agent-runtime planning, launching,
critiquing, deciding and reporting — without deploying anything and without Modal. One
command boots the stack on `localhost`, creates a real `sla_tickets` study, lets the
Managed-Agents LLM drive it, and prints the rubric grade.

```
┌──────────────┐   POST /api/studies        ┌───────────────────┐
│  e2e driver  │ ─────────────────────────▶ │  Worker (wrangler  │
│ (curl/Node)  │   POST .../message (1×)     │  dev --local)      │
└──────────────┘                            │  D1 + R2 miniflare │
        ▲ grade                             └─────────┬─────────┘
        │                                             │ triggerAgentStart / SSE proxy
        │                                   ┌─────────▼─────────┐   custom tools
        │                                   │  agent-runtime     │ ─────────────────┐
        │                                   │  (Managed Agents)  │  profile/launch/  │
        │                                   │  = the LLM agent   │  critique/report  │
        │                                   └─────────┬─────────┘                   │
        │                                             │ launch_experiment           │
        │                                   ┌─────────▼─────────┐                   │
        └───────────────────────────────── │  local_runner_shim │ ◀────────────────┘
                                            │  (no Modal)        │
                                            └───────────────────┘
```

The LLM agent (Anthropic Managed Agents) does the profiling, hypotheses, launches,
critiques, the promote decision, and the report. The driver only POSTs the **study brief**
plus **one business-feedback message**, exactly as a human would in the cockpit — it never
POSTs experiment manifests.

## Prerequisites

- Node + npm.
- A populated repo-root `.env` with:
  - `ANTHROPIC_API_KEY` (real key — the agent-runtime calls the Managed Agents API),
  - `LABMATE_AGENT_ID`, `LABMATE_ENVIRONMENT_ID` (run `npm run agent:bootstrap` once if missing).
- For `REAL=1` only: a `python3` with `pandas`, `scikit-learn`, `numpy`, **and `optuna`**
  (the agent's scripts run for real and its tuned hypotheses import optuna). MOCK mode needs
  no python. A venv works on Python 3.9:
  `python3 -m venv .venv && .venv/bin/pip install pandas scikit-learn numpy optuna`, then
  run with `REAL=1 PY=.venv/bin/python scripts/e2e_local.sh`. If a tuned script's import is
  missing, that run records as `failed` (the shim never 500s) and the agent continues — but
  enough runs may then fail to miss the `experiments_ran >= 5` check, so install optuna.

This path calls the **live Anthropic Managed Agents API** (that *is* the agent). It never
deploys, never calls the live control plane / Modal / runtime — everything else is on
`localhost`. Test runs use `claude-sonnet-4-6` with a small budget for cost control.

## Run it

```bash
scripts/e2e_local.sh                  # MOCK runner (default) — fast, deterministic, no sklearn
REAL=1 scripts/e2e_local.sh           # REAL runner — agent scripts train on the real CSV
```

Useful overrides (env vars):

| var            | default                         | meaning                                            |
| -------------- | ------------------------------- | -------------------------------------------------- |
| `REAL`         | `0`                             | `1` → real sklearn training via `scripts/real_runner.py` |
| `MODEL`        | `claude-sonnet-4-6`             | agent model for the run (cheap by default)         |
| `UPDATE_AGENT` | `1`                             | re-bake the agent onto `MODEL` (idempotent live call); set `0` to skip |
| `MAX_TRIALS`   | `8`                             | study trial budget                                 |
| `DEADLINE_S`   | `420`                           | overall wait budget for the grade                  |
| `WORKER_PORT` / `SHIM_PORT` / `RUNTIME_PORT` | `8787` / `8899` / `8990` | local ports                           |

The script is idempotent and kills every background process it starts on exit (`trap`).
Logs land in `/tmp/labmate_{shim,wrangler,runtime}.log`. It exits `0` when the study grades
`done` (all required rubric checks pass), `2` otherwise.

## What the components are

- **`scripts/local_runner_shim.mjs`** — a no-Modal stand-in for the Modal runner endpoint.
  The Worker POSTs the same experiment payload it would send to Modal; the shim returns the
  same response shape (`metrics`, `params.model`, `artifacts` incl. `features`/`dummy`/
  `n_train/n_val/n_test`, `provenance.{dataset_hash,code_hash,seed}`, `fpr_guardrail_satisfied`).
  - `MOCK=1` (default): deterministic, plausible metrics. A baseline (`DummyClassifier`/
    `baseline`) lands ~recall 0.28; tuned models climb with feature signal, staying within
    the FPR guardrail, so a clear best emerges. Banned columns are stripped from the
    returned feature list.
  - `REAL=1`: runs the agent-authored python script for real (via `scripts/real_runner.py`)
    on the stripped CSV from `LABMATE_DATASET_BASE` / `examples/sla_tickets/data.csv`.
- **`scripts/real_runner.py`** — REAL-mode helper. Resolves the CSV, physically strips
  banned/leakage columns, runs the agent script in a scratch `/work` dir, reads back
  `result.json`, coerces metrics, stamps provenance. Never raises to the shim.
- **`scripts/e2e_local_driver.mjs`** — creates the study, injects ONE early human-feedback
  message (so a launched run records `applied_feedback_id` and `feedback_affected_plan`
  passes), then polls the rubric grade until `done`.
- **`scripts/e2e_local.sh`** — the one-command orchestrator (this file documents it).

## Why the early human-feedback message

The rubric's `feedback_affected_plan` check requires a launched run to carry an
`applied_feedback_id`. The Worker auto-attaches the most recent human-feedback constraint
to every *subsequently* launched run (`resolveAppliedFeedbackId`). So the driver injects
the business-feedback message **before** the agent spends its trial budget — exactly as a
human would steer early in the cockpit — and every run the agent then launches is linked to
that feedback.

## Expected result

A completed, agent-driven study grading `done` (24/24 required checks), e.g.:

```
verdict:  done (24/24 required checks)
ledger:   hypotheses=5 runs=5 (completed=5) critiques=7 decisions=1 feedback=3 artifacts=1
promoted: run_…   all required checks PASS ✅
```

Including `caught_an_issue` — the agent records a leakage critique (`led_to_decision: rerun`)
before any tuned run, the seeded methodological catch.
