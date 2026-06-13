---
name: tabular-ds-protocol
description: The non-negotiable protocol for a tabular ML study — deterministic split first, baseline before tuned models, document the target and metric, leakage review, compare to baseline, produce a model card. Load at the start of any Labmate study.
---

# Tabular DS protocol

Follow this order. Hooks and the control plane enforce it; do not skip steps.

1. **Deterministic split FIRST.** Create the split (time-based for ordered data, else stratified) with a recorded `seed` before any feature engineering or training. Never random-shuffle data with time order.
2. **Document target + metric.** Write the target definition (and the moment of prediction) and the primary metric with its rationale and guardrail into the data + metric contracts.
3. **Leakage review BEFORE training.** Scan for post-outcome columns; default them to banned. (See the `leakage-review` skill.)
4. **Baseline before tuned models.** Always run a dummy + logistic/linear baseline first; it is the bar every later model must clear. Tag it `baseline`.
5. **Tune on validation only.** Touch the test split exactly once, at the very end.
6. **Compare to baseline.** A model is only worth promoting if it beats the baseline on the primary metric within the guardrail, with a calibration check.
7. **Model card.** Produce a reproducible report with a provenance footer (`dataset_hash`, `code_hash`, `seed`).

Every run links to a hypothesis and carries a rationale; every critique and decision is recorded.
