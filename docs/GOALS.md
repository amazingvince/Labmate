# Goals

Labmate is built to be driven by a single completion condition. Below are the
`/goal` statements to paste into Claude Code — one for the headline build, plus
smaller phase goals if you want to stage it.

## Headline goal (paste this into Claude Code after KICKOFF)

```
/goal Build a complete Labmate study on examples/sla_tickets.
Done means: data contract exists; baseline and at least 5 experiments ran in Modal;
leakage review passed before any non-baseline training; the critic caught at least
one methodological issue (leakage or test-set tuning) and triggered a rerun or
rejection; best model selected and compared to baseline; final report + model card
generated with a reproducible command and provenance footer; the live Cloudflare URL
shows every run linked to its hypothesis, rationale, critique, and human feedback;
and grade_study_against_rubric against docs/rubric.json returns all required checks
passing.
```

## Phase goals (optional staging — matches docs/BUILD_PLAN.md)

### Phase 1 — one run works (10:30–12:00)
```
/goal Make a single experiment run end to end: create_study and profile_dataset on
examples/sla_tickets, launch_experiment with the fixed runner.py on Modal, log metrics
and artifacts, and have the run appear in Cloudflare D1 and in the cockpit. Verifiable
when query_runs(study_id) returns one completed run with metrics.
```

### Phase 2 — cockpit (12:00–1:00)
```
/goal The cockpit shows a study page with the brief+rubric pane, experiment cards with
approve/deny/rerun buttons, a run table, a human-feedback box, artifact links, and a
"Generate report" button. Verifiable when the deployed Worker URL renders the seeded
study with at least one run.
```

### Phase 3 — orchestration (1:00–2:00)
```
/goal The run-study.js workflow drives profile -> plan -> approve -> run -> critique ->
report by delegating to the ds-planner, experiment-runner, experiment-critic, and
report-writer subagents, with hooks logging every run and gating Modal launches.
Verifiable when one `node .claude/workflows/run-study.js examples/sla_tickets` call
produces a study that advances through all phases (pausing at the human checkpoint).
```

### Phase 4 — autonomous loop + the "caught it" moment (2:00–3:00)
```
/goal Generate 5-8 experiment manifests, run them, have the critic flag the planted
test-set-tuning issue and rerun the corrected experiment, then produce the final report.
Verifiable when grade_study_against_rubric returns caught_an_issue == pass.
```

## Non-goals (do not let the agent wander into these)

- Generic dashboard as the main product.
- Warehouse connector / production MLOps deployment.
- Notebook replacement, deep learning, or GPU training.
- Arbitrary "agent writes any code and runs it anywhere" autonomy.
- Any medical, education, or sports dataset (banned by hackathon rules).
