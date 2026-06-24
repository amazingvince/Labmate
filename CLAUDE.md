# CLAUDE.md — Labmate project memory

This file is auto-loaded by Claude Code. It holds build/test commands, conventions, and
contracts. Read `docs/BRIEF.md`, `docs/RUBRIC.md`, and `docs/GOALS.md` for the what/why.

## What we're building (one line)

An agent-native data science harness: the human gives business judgment; Claude plans,
runs, critiques, documents, and iterates on tabular ML experiments. The **evidence ledger**
(hypothesis → experiment → evidence → decision) is the product.

@docs/BRIEF.md
@docs/data_contract.md
@docs/metric_contract.md

## Commands

```bash
# preflight: verify node, python, modal, wrangler, and .env keys
./scripts/preflight.sh

# regenerate the seeded demo dataset (deterministic)
python scripts/gen_dataset.py

# MCP server (local dev)
cd apps/mcp-server && npm install && npm run dev

# Cloudflare control plane
cd apps/web && npm install
npx wrangler d1 execute labmate --file=./schema.sql   # apply DB schema
npx wrangler dev                                       # local
npx wrangler deploy                                    # ship -> LABMATE_PUBLIC_URL

# Modal runner
pip install modal && modal deploy apps/modal-runner/runner.py

# drive the full study loop
node .claude/workflows/run-study.js examples/sla_tickets
```

## Hard rules (these are also enforced by hooks in .claude/settings.json)

1. **Never train before a leakage review.** Always create a deterministic split FIRST and
   always run a baseline (dummy/logistic/linear) before any tuned model.
2. **Compute launches require human approval.** Modal jobs are gated. Do not bypass hooks.
3. **No destructive actions** (rm -rf, dropping tables, deleting R2 objects) without
   explicit human approval.
4. **Every run links to a hypothesis** and carries `rationale`. **Every decision**
   (promote/reject/rerun/branch/stop) is recorded.
5. **Tuning happens on validation, never test.** Test split is touched once, at the end.
6. **Claude calls semantic MCP tools** (`launch_experiment`, `record_human_feedback`), not
   raw SQL or raw Modal APIs.
7. Stay inside `docs/GOALS.md` non-goals. No medical/education/sports datasets.

## The scientific loop

```
brief -> profile_dataset -> data contract
      -> propose_experiments (hypothesis cards)
      -> [HUMAN CHECKPOINT: approve/edit/reject/guide]
      -> launch_experiment (Modal) x N, logging metrics+rationale+hypothesis_id
      -> critic reviews (leakage, test-set tuning, metric concerns)
      -> rerun corrected experiments
      -> write_report (model card + provenance)
      -> grade_study_against_rubric (docs/rubric.json)
```

Two ways to drive this loop — they are different:
- **Interactive Claude-Code path** drives it by delegating to the subagents below
  and firing the `.claude/settings.json` hooks (this is where `experiment-critic`
  et al. actually run).
- **`.claude/workflows/run-study.js`** is a headless, flat Node driver that calls
  the control-plane API in sequence to reproduce the same study deterministically.
  It does **not** spawn subagents or fire the hooks — it is the reproducible replay.

## Subagents (.claude/agents)
- **ds-planner** — profiles data, writes the contract, proposes hypothesis cards.
- **experiment-runner** — turns an approved card into a manifest, launches Modal, logs runs.
- **experiment-critic** — reviews runs for leakage / test-set tuning / metric issues; emits
  critiques and decisions.
- **report-writer** — assembles the model card with provenance and the reproducible command.

## Skills (.claude/skills)
- **tabular-ds-protocol** — deterministic split, baseline, document target+metric, leakage
  check, compare to baseline, produce model card.
- **leakage-review** — scan column names for post-outcome signals, check timestamp ordering,
  feature availability at prediction time, require approval for suspicious features.
- **optuna-search** — small search spaces, capped trials, TPE default, prune, log trial-level
  params/metrics, tune on validation only.
- **model-card** — objective, data, split, experiments, best result, risks, next steps,
  provenance footer.

## Contracts (single source of truth)
- **Data contract** (`docs/data_contract.md`): target, leakage candidates, missingness,
  categoricals, dates, row count, split strategy + seed, banned columns.
- **Metric contract** (`docs/metric_contract.md`): primary metric, rationale, guardrails,
  segment definitions.
These are filled per-study by `profile_dataset`; the committed versions describe the
`sla_tickets` golden path.

## Conventions
- IDs: `study_<ulid>`, `hyp_<ulid>`, `run_<ulid>`, `crit_<ulid>`, `dec_<ulid>`.
- Seeds: default `42`, recorded on every split and run. Reproducibility is non-negotiable.
- Artifacts in R2 keyed `studies/<study_id>/<kind>/<filename>`; every report artifact
  carries `dataset_hash`, `code_hash`, `seed`.
- Schemas live in `packages/schemas` — change there, not ad hoc.

## Definition of done
`grade_study_against_rubric` against `docs/rubric.json` returns all `required` checks
passing. That includes `caught_an_issue` — the session must catch/correct a real
methodological problem (the dataset + skills are seeded to guarantee one).
