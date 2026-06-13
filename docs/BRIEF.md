# Labmate — Agent-native data science harness

## Problem

Data scientists spend most of their time on experiment *mechanics*, not science:
profiling data, checking for leakage, writing training scripts, comparing runs,
documenting decisions, and translating vague business feedback into modeling work.
AutoML optimizes a model once the problem is already framed — it does not help frame
the target, define the metric, encode leakage rules, or manage the collaborative loop.
Long-horizon data-analysis agents fail mostly because they lose or corrupt their
evolving analytical state.

## User

A data scientist or analytics engineer working on a **tabular business prediction
problem** (binary classification or regression).

## What we built

Labmate lets a human provide a **brief, dataset, target, metric, and constraints**.
Claude then:

1. profiles the data and writes a **data contract** (target, candidate leakage columns,
   missingness, categoricals, dates, row count, split strategy);
2. proposes **hypothesis-driven experiment cards** (not parameter sweeps);
3. pauses at **human checkpoints** for approval / edits / guidance;
4. launches **controlled experiments in Modal sandboxes**;
5. logs metrics, hyperparameters, artifacts, notes — **and the hypothesis, rationale,
   critique, and decision behind each run** — into an agent-native ledger;
6. **critiques** its own results (leakage, test-set tuning, metric concerns);
7. produces a **reproducible report / model card** with provenance.

## The wedge (vs AutoML)

| AutoML does | Labmate does |
| --- | --- |
| Optimizes for a fixed target/metric | Helps *define* target, metric, leakage rules, business utility |
| Treats experiments as parameter sweeps | Treats experiments as hypothesis-driven evidence |
| Logs runs for humans | Logs runs for **agents and humans** |
| Picks a best model | Explains **why a model should or should not be trusted** |
| Assumes the problem is framed | Collaborates to frame and reframe the problem |

W&B / MLflow log *what happened*. Labmate logs **what the agent believed, why it acted,
what evidence changed its mind, and what the human corrected.**

## Done (high level — machine-checkable version in RUBRIC.md)

A study is complete when:
- a data contract exists,
- a baseline model ran,
- at least five experiments ran,
- a leakage review passed,
- all runs are searchable and linked to a hypothesis,
- human feedback is recorded and affected later experiments,
- a best model is selected and compared to baseline,
- a final report / model card is generated with a reproducible command,
- the live URL shows the evidence ledger.

## One-sentence judge pitch

> We built the missing harness for autonomous data science: Claude does the profiling,
> planning, experiment execution, critique, and reporting, while the human steers through
> business feedback — and every hypothesis, metric, artifact, and decision is captured in
> an agent-native experiment tracker.

## Mapping to Build Day scoring

- **Impact (35%)** — back-office DS workflow that takes weeks, compressed; fits the
  "back-office workflow that takes weeks today" problem statement.
- **Demo (35%)** — live cockpit + a scripted "agent caught leakage / test-set tuning"
  moment that proves the impact (see DEMO_SCRIPT.md).
- **Opus 4.8 Use (15%)** — Opus does the planning, leakage reasoning, critique, and
  natural-language-feedback → structured-constraint translation.
- **Orchestration (15%)** — a single `/goal` + `run-study.js` reruns the whole loop;
  "done" is verifiable by `grade_study_against_rubric` against RUBRIC.md without a human.
