---
name: model-card
description: Assemble a trustworthy, reproducible model card — objective, data, split, experiments, best vs baseline, risks, next steps, and a provenance footer. Load when writing the final report for a study.
---

# Model card

A model card is a view of the evidence ledger. Include, in order:

1. **Objective** — the business brief, the target (and its definition), the primary metric + guardrail.
2. **Data** — dataset + row count, the split strategy with seed, banned/leakage columns, missingness notes.
3. **Experiments** — the table of runs: model family, feature set, tags, key metrics, status — each linked to its hypothesis.
4. **Best vs baseline** — the promoted model and the baseline, side by side, on the primary metric within the guardrail. Report required segments (e.g. enterprise vs rest).
5. **Critiques & decisions** — what the critic caught (leakage, test-set tuning, calibration) and the decisions it led to.
6. **Risks & next steps** — calibration caveats, robustness concerns, what to try next, ideas explicitly rejected and why.
7. **Reproducible command** — the single command that reruns the study end to end
   (e.g. `node .claude/workflows/run-study.js examples/sla_tickets`). State its scope
   honestly: this replays the *study loop* from the dataset via the manifest path and
   produces a fresh study with new IDs — it does **not** byte-reproduce one promoted
   run, and it needs the repo + a reachable control plane + the dataset (local
   `examples/…` or the network URL `{LABMATE_PUBLIC_URL}/data/<dataset>.csv`). A reader
   with only the live URL can inspect the ledger but cannot run this command. Include
   the study id so the original run is still traceable in the ledger.
8. **Provenance footer** — `dataset_hash`, `code_hash`, `seed`.

Never state a number the ledger does not support. If nothing beat the baseline meaningfully, say so and recommend `stop`.
