# Labmate MVP Rubric

This is the definition of "done." The machine-gradable version lives in
`docs/rubric.json`; the `grade_study_against_rubric` MCP tool checks a study against
it and returns pass/fail per criterion. A study is **done** when every `required`
criterion passes.

## Functional
- [ ] User can create a study from a brief and a CSV.
- [ ] System profiles the dataset and writes a data contract.
- [ ] System proposes at least five experiment cards.
- [ ] Human can approve / reject / add feedback.
- [ ] Approved experiments run in Modal.
- [ ] Runs log metrics, params, artifacts, notes, and hypothesis IDs.
- [ ] Final report is generated.

## Data-science quality
- [ ] Deterministic train / validation / test split (fixed seed, recorded).
- [ ] Baseline (dummy or logistic/linear) included.
- [ ] Target and metric documented with rationale.
- [ ] Leakage review performed **before** training.
- [ ] Best model compared to baseline.
- [ ] Critic reviews the final result.

## Agent-native tracking
- [ ] Each run is linked to a hypothesis.
- [ ] Each run includes agent rationale.
- [ ] Human feedback is stored and demonstrably affects later experiments.
- [ ] Runs are queryable by metric, feature set, model type, and critique.

## Orchestration
- [ ] Workflow can be rerun from one command (`run-study.js` / `/goal`).
- [ ] Claude uses subagents / skills / hooks (or Managed Agent outcomes).
- [ ] Completion is verifiable by this rubric without a human.
- [ ] Session log shows the agent caught or corrected at least one issue.

## Safety & control
- [ ] Compute launches require approval.
- [ ] Suspicious leakage fields are blocked unless explicitly approved.
- [ ] Sandboxed execution only (no arbitrary egress).
- [ ] Artifacts include provenance (dataset hash, code hash, seed).
