# Labmate — an agent-native data science harness

**Live:** https://amazingvince.com · **Repo:** https://github.com/amazingvince/Labmate

> Give Claude a dataset, a target, a business objective, and a rubric. A real
> **Anthropic Managed Agent (Opus 4.8)** profiles the data, proposes hypotheses,
> runs controlled experiments in sandboxes, critiques its own results, asks for human
> guidance at decision points, and produces a reproducible report — and **every
> hypothesis, run, critique, and decision lands in an agent-native evidence ledger
> you can steer live.**

🏗️ **Built in one day at the Claude Build Day (June 13, 2026), entirely with Claude
Code (Opus 4.8).** Everything in this repo was created during the event — see
[`submission/SESSIONS.md`](submission/SESSIONS.md) for the session-by-session log.

---

## The problem

Data scientists spend most of their time on experiment *mechanics*, not science:
profiling data, checking for leakage, writing training scripts, comparing runs,
documenting decisions, and turning vague business feedback into modeling work.
**AutoML optimizes a model once the problem is already framed** — it doesn't help
frame the target, define the metric, encode leakage rules, or manage the
collaborative loop.

| AutoML does | **Labmate does** |
| --- | --- |
| Optimizes for a fixed target/metric | Helps *define* target, metric, leakage rules, business utility |
| Treats experiments as parameter sweeps | Treats experiments as **hypothesis-driven evidence** |
| Logs runs for humans | Logs runs for **agents and humans** |
| Picks a best model | Explains **why a model should or should not be trusted** |

W&B / MLflow log *what happened*. Labmate logs **what the agent believed, why it
acted, what evidence changed its mind, and what the human corrected.**

---

## The scientific loop (the product)

```
brief + dataset + target + metric + constraints   ← human gives judgment
   → profile data → write a data contract
   → propose hypothesis-driven experiment cards
   → [HUMAN CHECKPOINT: approve / edit / reject / guide]
   → launch experiments in Modal sandboxes  (real sklearn / optuna)
   → critique results (leakage, test-set tuning, metric misuse)
   → rerun corrected experiments
   → write a reproducible report + model card with provenance
   → grade against the rubric — "done" verified without a human
```

The **evidence ledger** — *hypothesis → experiment → evidence → decision* — is the
product. The cockpit is how the human watches it happen and steers mid-flight.

---

## Three things this submission is built around

### 1. Goals — one machine-checkable completion condition
The whole study is driven by a single `/goal` ([`docs/GOALS.md`](docs/GOALS.md)).
"Done" is not vibes — it's an explicit, gradable statement:

> data contract exists; baseline + ≥5 experiments ran in Modal; leakage review passed
> *before* any non-baseline training; the critic caught ≥1 methodological issue and
> triggered a rerun; best model compared to baseline; reproducible report generated;
> the live URL shows every run linked to its hypothesis, rationale, critique, and human
> feedback; and `grade_study_against_rubric` returns all required checks passing.

### 2. Rubric — "done" is verifiable by the model, not a human
[`docs/rubric.json`](docs/rubric.json) is a machine-gradable definition of done: 24
checks across Functional, DS-quality, Agent-native tracking, Orchestration, and
Safety. `POST /api/grade` evaluates a study and returns pass/fail per check. The
keystone check, `caught_an_issue`, only passes if the agent caught and corrected a
**real** methodological problem (leakage or test-set tuning) on its own — see
[`docs/RUBRIC.md`](docs/RUBRIC.md).

```bash
npm run guard          # schema-check + lint + tests + agent smoke test
npm run test:agent     # the self-correction loop, isolated:
#   profile → propose → leaky launch REJECTED → corrected rerun → report → done
```

### 3. Parallel build — the orchestration story
This app was built **front-end and back-end in parallel** by two Claude Code
sessions in separate git worktrees, integrating against **one OpenAPI contract**
([`apps/api-spec/openapi.yaml`](apps/api-spec/openapi.yaml)). The contract is the
only integration point: the front end built against a generated mock; the back end
implemented routes to match; integration was a one-line `VITE_API_BASE` swap. The
full plan — worktree layout, per-track kickoff prompts and `/goal`s, the
contract-first rule — is in [`docs/PARALLEL_BUILD.md`](docs/PARALLEL_BUILD.md).

```bash
npm run spec:lint     # validate the contract
npm run spec:mock     # spec-accurate mock API on :4010 (front end builds on this)
npm run spec:types    # generate packages/api-types for both tracks
```

Another team could rerun this setup tomorrow on a new problem: one contract, two
`/goal`s, `npm run guard` + `/api/grade` as the green signals.

---

## Architecture

```
Cockpit (apps/cockpit)  — React/TS mission control: brief+rubric, experiment cards,
   │                       evidence ledger, NL-feedback box, live agent activity
   │  OpenAPI contract (apps/api-spec/openapi.yaml)
   ▼
Control plane (apps/web)  — Cloudflare Worker + D1 (ledger) + R2 (artifacts) + DO (live stream)
   │
   ▼
Agent runtime (apps/agent-runtime)  — the bridge to a real Anthropic Managed Agent:
   │   creates a session, holds the SSE event stream, dispatches the agent's custom
   │   tool-use (propose_experiments, launch_experiment, query_runs, record_critique,
   │   write_report) to real handlers, and feeds results back. Human "suggest changes"
   │   is injected as a user.message mid-run.
   ▼
Modal runner (apps/modal-runner)  — the ONLY experiment executor: fixed runner.py
       (sklearn / pandas / optuna). Rejects banned-column features and tune_on=test.
```

Safety is structural, not advisory: the agent never runs arbitrary training code; it
emits a manifest, the fixed Modal runner is the only executor, compute launches
require a recorded approval (402 without one), and every report artifact carries
`dataset_hash`, `code_hash`, and `seed`.

---

## How Claude built it (Opus 4.8 use)

Opus 4.8 did the actual data-science reasoning and the build:
- **Planning** — turned a brief into hypothesis-driven experiment cards.
- **Leakage reasoning** — caught post-outcome columns in the dataset before training.
- **Critique** — flagged a test-set-tuning manifest and triggered a corrected rerun.
- **NL → structured constraint** — parsed *"recall matters more than precision, keep
  FPR ≤ 20%"* into `{ primary_metric: recall, guardrail: fpr <= 0.20 }` that shaped
  later experiments.
- **The build itself** — the whole repo (~14k LOC) was written by Claude Code across
  the sessions in [`submission/SESSIONS.md`](submission/SESSIONS.md), using subagents
  (`.claude/agents`), skills (`.claude/skills`), hooks, and a dynamic workflow.

---

## Repo layout

```
labmate/
  .claude/
    agents/        ds-planner · experiment-runner · experiment-critic · report-writer
    skills/        tabular-ds-protocol · leakage-review · optuna-search · model-card
    workflows/     run-study.js  (the orchestrated golden path)
    settings.json  hooks: log every run, block destructive cmds, gate Modal jobs
  apps/
    cockpit/       React/TS mission-control SPA
    web/           Cloudflare Worker + D1 + DO + R2 control plane
    agent-runtime/ Anthropic Managed Agents ↔ Modal/control-plane bridge
    modal-runner/  fixed experiment runner (sklearn/optuna)
    mcp-server/    semantic MCP tool layer
    api-spec/      openapi.yaml — the single integration contract
  packages/schemas/  shared JSON Schemas (study/run/hypothesis/manifest)
  examples/sla_tickets/  bundled synthetic dataset + brief + rubric (golden demo)
  docs/          BRIEF · GOALS · RUBRIC · PARALLEL_BUILD · GOAL_E2E · DEMO_SCRIPT · rubric.json
  submission/    SESSIONS.md (session log) + submission package
```

---

## Run it

```bash
npm run setup                 # copies .env, installs deps, seeds data, runs guardrails
# fill keys in .env (documented in docs/ENV.md), then:
./scripts/preflight.sh        # checks node, python, modal, wrangler, keys
npm run guard                 # prove the build is honest (incl. the self-correction loop)

# the live end-to-end (real Anthropic Managed Agent + real Modal):
npm run agent:bootstrap       # create the versioned agent + cloud environment (once)
npm run demo:e2e              # drive the seeded study deterministically end to end
```

Full runbook: [`HOWTO.md`](HOWTO.md). End-to-end architecture + the demo loop:
[`docs/GOAL_E2E.md`](docs/GOAL_E2E.md).

---

## The golden demo

Bundled [`examples/sla_tickets`](examples/sla_tickets) is a synthetic support-ticket
SLA-breach dataset (non-medical, non-education, non-sports — safe under hackathon
rules). It deliberately ships post-outcome columns and a seeded test-set-tuning
manifest so the agent has a **real** issue to catch. The demo proves Claude can take
a DS brief, plan, **catch a methodological issue and rerun corrected**, fold in human
feedback, and produce a reproducible conclusion — live. Script:
[`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

---

## License

MIT.
