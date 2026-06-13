# Labmate — an agent-native data science harness

> Give Claude a dataset, a target, a business objective, and a rubric.
> Labmate profiles the data, proposes hypotheses, runs controlled experiments
> in sandboxes, logs every run with searchable reasoning, asks for human
> guidance at decision points, and produces a reproducible report.

This repo is a **hackathon starter scaffold**. It is wired so Claude Code can
drive the whole build autonomously: there is a brief, a machine-gradable rubric,
a `/goal`, subagents, skills, hooks, and a dynamic workflow. You add API keys and
point Claude at it.

---

## 60-second start (do this first at Build Day)

```bash
# 1. clone your repo, cd in
npm run setup                 # copies .env, installs deps, seeds data, runs guardrails
#                               (idempotent — safe to re-run anytime)

# 2. fill in your keys in .env  (every key is documented in docs/ENV.md)

./scripts/preflight.sh        # 3. checks node, python, modal, wrangler, and keys

# 4. open Claude Code in this directory, then paste the contents of:
docs/KICKOFF.md               # the exact prompt + /goal to start the build
```

Then let it run. The workflow in `.claude/workflows/run-study.js` orchestrates
profile → plan → human-approve → run → critique → report.

**Static guardrails** keep the autonomous build honest. Run them anytime — and
they run in CI on every push (`.github/workflows/guard.yml`):

```bash
npm run guard          # schema-check + lint + smoke tests
npm run guard:full     # the above + Python runner lint/tests
npm run schema:check   # validates schemas, rubric shape, cross-file consistency
npm test               # rubric-shape + dataset-contract smoke tests
```

---

## What this is (and isn't)

**Is:** a cockpit for the scientific loop — *hypothesis → experiment → evidence → decision*.
The human steers with business judgment; Claude does profiling, planning, execution,
critique, and reporting. Every hypothesis, metric, artifact, and decision lands in an
agent-native experiment ledger.

**Isn't:** AutoML with a chat box, a generic dashboard, a warehouse connector, an
MLOps deployment system, a notebook replacement, or "agent runs arbitrary code anywhere."

See `docs/BRIEF.md` for the full framing and `docs/RUBRIC.md` for the definition of done.

---

## Architecture

```
Claude Code (this repo, .claude/)
        |  MCP tools (semantic, not raw SQL/Modal)
        v
Labmate MCP Server  (apps/mcp-server)         <-- create_study, propose_experiments,
        |                                          launch_experiment, query_runs,
        |                                          record_human_feedback, write_report,
        |                                          grade_study_against_rubric
        v
Cloudflare Control Plane (apps/web)
  - Worker API
  - D1: studies, hypotheses, runs, feedback, critiques, decisions
  - Durable Object: live study state / event stream
  - R2: artifacts, reports, model files
        |  job manifest
        v
Modal Runner (apps/modal-runner)
  - fixed runner.py: sklearn / pandas / optuna
  - no arbitrary data egress
        |
        v
Tracker tables (packages/schemas defines the shape)
  metrics · hyperparameters · artifacts · notes · hypotheses · critiques · decisions
```

The **evidence ledger is the product**. The UI is the cockpit.

---

## Repo layout

```
labmate/
  .claude/
    agents/        ds-planner, experiment-runner, experiment-critic, report-writer
    skills/        tabular-ds-protocol, leakage-review, optuna-search, model-card
    workflows/     run-study.js  (the orchestrated golden path)
    settings.json  hooks: log every run, block destructive cmds, gate Modal jobs
  .github/
    workflows/     guard.yml  (CI: schema-check + lint + tests + determinism)
  apps/
    web/           Cloudflare Worker + D1 + DO + R2 cockpit
    mcp-server/    semantic MCP tool layer
    modal-runner/  fixed experiment runner (sklearn/optuna)
  packages/
    schemas/       shared JSON Schemas for study/run/hypothesis/manifest
  examples/
    sla_tickets/   bundled synthetic dataset + brief.md + rubric.md (golden demo)
  docs/
    BRIEF.md  RUBRIC.md  GOALS.md  KICKOFF.md  DEMO_SCRIPT.md  BUILD_PLAN.md  ENV.md
    rubric.json  data_contract.md  metric_contract.md
  scripts/
    setup.mjs       one-command bootstrap (npm run setup)
    schema-check.mjs static guardrail over schemas + rubric + cross-file refs
    preflight.sh     tooling + key validation
    gen_dataset.py   deterministic demo-data generator
    grade_study.py   local impl behind grade_study_against_rubric + Stop hook
  tests/
    rubric.shape.test.mjs  dataset.contract.test.mjs
  .env.example
  HOWTO.md          start-to-finish runbook for Build Day
```

---

## Building front end + back end in parallel

The control-plane API is specified once in `apps/api-spec/openapi.yaml` and both
the MCP server and the cockpit go through those same routes. That spec is the
single integration point, so two tracks can build at the same time:

- **`apps/api-spec/openapi.yaml`** — the contract (OpenAPI 3.1; mirrors the MCP
  tools and `apps/web/src/worker.js`). See `apps/api-spec/README.md` for what it
  describes.
- **`docs/PARALLEL_BUILD.md`** — git worktree layout, per-track kickoff prompts
  and `/goal`s, and the contract-first workflow (front end builds against a mock
  generated from the spec; back end implements routes to match it).

```bash
npm run spec:lint     # validate the contract
npm run spec:mock     # spec-accurate mock API on :4010 (front end builds on this)
npm run spec:types    # generate packages/api-types for both tracks
npm run spec:docs     # browsable API reference
```

## ENV / keys

Copy `.env.example` to `.env` and fill it in. Details and where to get each key:
`docs/ENV.md`.

---

## The golden demo

Bundled `examples/sla_tickets` is a synthetic support-ticket SLA-breach dataset
(non-medical, non-education, non-sports — safe under hackathon rules). The demo
proves Claude can take a DS brief, plan experiments, **catch a leakage / test-set-tuning
issue**, fold in human feedback, and produce a reproducible conclusion. Full script:
`docs/DEMO_SCRIPT.md`.

---

## License

MIT. Repo must be public for the hackathon. See hackathon rules in your participant guide.
