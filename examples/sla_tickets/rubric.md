# Study rubric — Support ticket SLA breach

This study is done when:

- A data contract exists naming `breached_sla` as the target and flagging the post-outcome
  leakage columns as banned.
- A deterministic **time-based** split (seed recorded) is in place.
- A baseline (dummy + logistic) ran first.
- At least five experiments ran in Modal, each linked to a hypothesis with rationale.
- The leakage review caught the post-outcome columns **before** any non-baseline training.
- The critic caught at least one methodological issue (the seeded test-set-tuning run) and
  triggered a rerun on the validation split.
- The promoted model beats the baseline on recall while keeping FPR <= 0.20, with a
  calibration check.
- Enterprise-vs-rest segment performance is reported.
- A model card with a reproducible command and provenance footer is generated.
- `grade_study_against_rubric` against `docs/rubric.json` returns all required checks passing.

The global, machine-gradable rubric lives at `docs/rubric.json`; this file is the
study-specific reading of it.
