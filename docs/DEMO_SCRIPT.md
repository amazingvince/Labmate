# Golden demo script

Dataset: `examples/sla_tickets` (synthetic support-ticket SLA-breach data — safe under
hackathon rules; non-medical, non-education, non-sports). Goal: predict which tickets
will breach SLA, optimizing recall at an acceptable false-positive cost.

The demo's job is to prove Claude can take a DS brief, plan, **catch a methodological
issue**, fold in human feedback, and produce a reproducible conclusion — live.

## Run of show (target ~60–90s for video; 3 min for live finals)

1. **Open Claude Code.** Show the `/goal` (from `docs/GOALS.md`) on screen.

2. **Claude creates the study and profiles the data.** Data contract appears: target =
   `breached_sla`, row count, categoricals, date columns, candidate leakage columns.

3. **Leakage flag (planted moment #1).** Claude flags:
   > `resolved_at`, `time_to_resolution`, and `closed_status` appear unavailable at
   > prediction time. I recommend excluding them.
   In the cockpit, click **Ban feature** / approve the exclusion.

4. **Claude proposes experiment cards** — baseline, RF with class weighting, gradient
   boosting with calibrated threshold, a no-leakage feature set, segment eval by
   customer tier, a small Optuna search.

5. **Human checkpoint.** Approve: *run 8 experiments, 10-minute budget.* Type a natural
   language constraint into the feedback box:
   > Recall matters more than precision, but false positives above 20% are not acceptable.
   Show it parsed into `{ primary_metric: recall, guardrail: false_positive_rate <= 0.20 }`.

6. **Modal jobs run.** Tracker logs runs; the cockpit updates live; each card shows its
   latest metric and the agent's rationale.

7. **Critic rejects a result (planted moment #2).** Claude:
   > This run tuned the threshold on the test split. I'm rerunning with a validation split.
   Show the decision recorded as `rerun`.

8. **Claude reruns the corrected experiment.**

9. **Final report appears**: best model, baseline comparison, metric table, top features,
   caveats, reproducible command, provenance footer, and all human feedback incorporated.

10. **Grade it.** Run `grade_study_against_rubric` → all required checks pass, including
    `caught_an_issue`. This is your "done is verifiable without a human" proof.

## What to narrate (for finals Q&A)

- *What you gave the model*: the brief, the rubric, the `/goal`.
- *How it verified its own work*: `grade_study_against_rubric` against `docs/rubric.json`.
- *The moment it caught a failure*: the test-set-tuning rerun (step 7), visible in the
  session log.

## The two planted moments

Both live in the dataset/skills, not in hardcoded output:
- **Leakage**: `examples/sla_tickets` deliberately includes post-outcome columns
  (`resolved_at`, `time_to_resolution`, `closed_status`); the `leakage-review` skill makes
  Claude catch them.
- **Test-set tuning**: the `optuna-search` and `tabular-ds-protocol` skills require tuning
  on a validation split; one experiment manifest is seeded to (incorrectly) tune on test so
  the `experiment-critic` has something real to catch. Keep this in to guarantee the moment
  fires on demo day.
