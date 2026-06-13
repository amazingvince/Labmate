---
name: optuna-search
description: Run small, capped hyperparameter searches that tune on validation only — TPE sampler by default, pruning on, bounded trial budget, every trial's params and metrics logged. Load when a hypothesis calls for tuning a model family.
---

# Optuna search

Search is a controlled experiment, not a sweep.

- **Tune on validation only.** `tune_on: validation`. Tuning on test is forbidden and the runner rejects it (422). Choose the decision threshold on validation too.
- **Small spaces.** Define a tight, justified search space per hypothesis — not every knob. Prefer a few meaningful axes.
- **Cap the budget.** Set `max_trials` and `timeout_seconds` from the study budget; respect `LABMATE_DEFAULT_MAX_TRIALS` / `LABMATE_DEFAULT_BUDGET_SECONDS`. Default sampler is **TPE**; enable **pruning** to kill weak trials early.
- **Log everything.** Each trial's params and metrics go into the run record so the search is auditable and reproducible (fixed `seed`).
- **Compare honestly.** The best searched model still has to beat the baseline within the guardrail before promotion, with a calibration check.

The manifest expresses the search; the fixed Modal runner executes it. No arbitrary code reaches the sandbox.
