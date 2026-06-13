# Labmate API & cockpit — what we're building

This README explains the thing the OpenAPI spec describes and why it's shaped the
way it is, so the front-end and back-end tracks share one mental model. For the
parallel-work mechanics (worktrees, prompts, goals), see
[`docs/PARALLEL_BUILD.md`](../../docs/PARALLEL_BUILD.md). For the product framing,
see [`docs/BRIEF.md`](../../docs/BRIEF.md).

---

## The product in one paragraph

Labmate is an **agent-native data science harness**. A human gives a brief, a
dataset, a target, a metric, and constraints. Claude profiles the data, proposes
hypotheses, runs controlled experiments in a sandbox, critiques its own results,
folds in human feedback, and produces a reproducible report. Everything the agent
believes, does, and is corrected on is captured in an **evidence ledger**:
*hypothesis → experiment → evidence → decision*. The ledger is the product; the
cockpit is how a human steers it.

---

## What the API is

The control plane is one **Cloudflare Worker** (`apps/web`) backed by:

- **D1** (SQLite) — the evidence ledger: studies, dataset versions, hypotheses,
  runs, critiques, decisions, feedback, artifacts.
- **R2** — artifacts: reports, model files, plots.
- **A Durable Object** — one instance per study session, holding live state and
  an event stream so the cockpit can update as runs complete.

Two clients talk to it, and **both go through the exact same HTTP routes** in
`apps/api-spec/openapi.yaml`:

1. **The MCP server** (`apps/mcp-server`) — the semantic tool layer Claude calls.
   Each MCP tool (`create_study`, `launch_experiment`, …) is a thin wrapper over
   one route. Claude never touches D1 or Modal directly; it calls business-level
   tools, and the Worker does the work.
2. **The cockpit** (`apps/cockpit`) — the human's mission control. It reads the
   ledger from `GET /api/studies/{id}` and writes via the documented POST routes
   (approvals, feedback, report generation).

```
  Claude Code ──MCP tools──▶ MCP server ──┐
                                          │  (same routes, same contract)
  Human ───────clicks──────▶ Cockpit  ────┤
                                          ▼
                            Cloudflare Worker  (apps/web)
                              D1 · R2 · Durable Object
                                          │  manifest
                                          ▼
                            Modal runner  (apps/modal-runner)
                              sklearn / optuna · fixed · no arbitrary code
```

Because both clients share the contract, **the OpenAPI spec is the only
integration point** between the front-end and back-end tracks. Build against it
in parallel; integrate by pointing the cockpit at the real Worker.

---

## The routes (and the MCP tool each mirrors)

| Route | Method | MCP tool | What it does |
|---|---|---|---|
| `/api/studies` | POST | `create_study` | Open the ledger from a brief. |
| `/api/studies` | GET | — | List studies (cockpit home). |
| `/api/studies/{id}` | GET | — | **The whole ledger** in one payload. |
| `/api/profile` | POST | `profile_dataset` | Profile data; write the data contract (columns, leakage candidates, split, seed). |
| `/api/experiments/propose` | POST | `propose_experiments` | Return hypothesis cards. |
| `/api/approvals/request` | POST | `request_approval` | Create a pending approval the human acts on. |
| `/api/experiments/launch` | POST | `launch_experiment` | Verify approval → Modal → record a run with provenance. |
| `/api/runs/query` | POST | `query_runs` | Filter runs by metric, model, hypothesis, tags, critique. |
| `/api/feedback` | POST | `record_human_feedback` | Store judgment + parsed constraints (approval is feedback). |
| `/api/reports` | POST | `write_report` | Build a model card → R2; record an artifact. |
| `/api/grade` | POST | `grade_study_against_rubric` | Pass/fail vs `docs/rubric.json`; the machine definition of done. |

Writes require the shared bearer token (`LABMATE_INTERNAL_TOKEN`). The two GET
reads the cockpit uses are public.

---

## The entities (the ledger)

All shapes live in `packages/schemas/*.schema.json` and are mirrored as OpenAPI
components. The spirit: log not just *what happened* but *what the agent believed,
why it acted, what changed its mind, and what the human corrected*.

- **Study** — brief, target, metric, constraints, budget, rubric, status.
- **DatasetVersion** — file hash, row count, per-column profile with
  `is_candidate_leakage`, split strategy + seed. (Provenance starts here.)
- **Hypothesis** — a falsifiable statement + rationale + expected outcome; the
  unit the human approves or rejects. Renders as an experiment card.
- **Run** — links to a hypothesis, carries metrics, params, artifacts,
  **rationale**, tags, and provenance (`dataset_hash`, `code_hash`, `seed`).
  `executor` is always `modal-runner`.
- **Critique** — leakage / test-set-tuning / metric / calibration / robustness
  finding, a recommendation, and what decision it led to.
- **Decision** — promote / reject / rerun / branch / stop, with the run it acted
  on and a reason.
- **Feedback** — human judgment (approval, ban-feature, change-metric, …) plus
  `parsed_constraints` the agent can apply to later manifests
  (`applied_feedback_id` closes that loop).
- **Artifact** — report / plot / model in R2, carrying provenance.
- **ExperimentManifest** — the *only* thing handed to the runner. Explicit
  feature allowlist (banned/leaky columns excluded), split with seed, model
  family, capped Optuna search that tunes **on validation only**. No arbitrary
  code reaches the sandbox.

---

## The cockpit (four panes, not a dashboard)

The front end renders the ledger as mission control:

1. **Brief + rubric** — objective, metric, guardrails, budget, "done" criteria.
2. **Experiment cards** — per hypothesis: expected impact, cost, status, latest
   metric, the agent's rationale, and approve / deny / rerun.
3. **Evidence ledger** — a timeline merging runs, critiques, and human feedback.
4. **Current recommendation** — e.g. "Promote model 7, but only after a
   calibration check," or "Stop; nothing beat baseline meaningfully."

Plus a natural-language feedback box (→ `/api/feedback`) and a "Generate report"
button (→ `/api/reports`). A dashboard as the main feature is explicitly a
non-goal — this is a cockpit for steering the scientific loop.

---

## Invariants the API enforces (so the demo holds up)

These are contract-level promises, checked by the back end and visible in the
rubric:

- **No training before a leakage review.** Leakage candidates default to banned;
  using one requires explicit human approval.
- **Compute is gated.** `launch_experiment` returns `402` without a recorded
  approval or when budget is exceeded.
- **Manifests are validated.** A banned column in `features`, or `tune_on=test`,
  is rejected `422`. Tuning happens on validation; test is touched once.
- **Everything is reproducible.** Every report artifact carries dataset hash,
  code hash, and seed; the report includes a one-line reproducible command.
- **Done is machine-checkable.** `/api/grade` evaluates the study against
  `docs/rubric.json` and returns a verdict without a human in the loop.

---

## How to work against it right now

```bash
npm run spec:lint     # validate the contract
npm run spec:mock     # fake but spec-accurate API on :4010 (front end builds on this)
npm run spec:types    # generate packages/api-types for both tracks
npm run spec:docs     # browsable API reference
```

- **Back end:** implement `apps/web` so each route matches the spec; prove it with
  a contract test that validates responses against the spec's schemas.
- **Front end:** build `apps/cockpit` against the `:4010` mock using the generated
  types; flip `VITE_API_BASE` to the Worker to integrate.

If you need to change the contract, change `apps/api-spec/openapi.yaml` first (on
a `spec/*` branch both tracks pull), regenerate types, then change code. The spec
leads; code follows.
