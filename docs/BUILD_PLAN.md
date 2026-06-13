# Build plan — Saturday, June 13 (Shack15, Ferry Building)

Hackathon begins 10:30 AM, submissions due **5:00 PM sharp**. This plan front-loads
"one run works" and protects the last hour for submission. Times assume you start the
build at 10:30.

| Time | Phase | Outcome |
| --- | --- | --- |
| 9:00–10:00 | Doors / breakfast | Arrive promptly, grab Wi-Fi (`Claude Build Day` / `problemsolvers`), claim the $500 credits link (24h expiry). |
| 10:00–10:30 | Kick-off | Lock the team name; confirm scope = this scaffold; create the public repo. |
| 10:30–11:00 | Scaffold check | `cp .env.example .env`, fill keys, `./scripts/preflight.sh` green. Open Claude Code, paste `docs/KICKOFF.md`. |
| 11:00–12:00 | **One run works** | `create_study` + `profile_dataset` on `examples/sla_tickets`; `launch_experiment` on the fixed `runner.py`; metrics+artifacts logged; run shows in D1 and the cockpit. *Success = `query_runs` returns one completed run.* |
| 12:00–1:00 | Cockpit | Study page: brief+rubric pane, experiment cards (approve/deny/rerun), run table, feedback box, artifact links, "Generate report". Ugly but functional. |
| 1:00 | Lunch | Eat at your machine if you're behind; otherwise step away 15 min. |
| 1:00–2:00 | Orchestration | `run-study.js` drives profile → plan → approve → run → critique → report via the four subagents; hooks log runs and gate Modal launches; skills wired in. |
| 2:00–3:00 | **Autonomous loop + "caught it"** | Generate 5–8 manifests, run them, critic flags the planted test-set-tuning bug and reruns corrected experiment, final report generated. *Success = `grade_study_against_rubric` → `caught_an_issue` passes.* |
| 3:00–4:00 | Polish the story | Make the UI resilient; seed deterministic data; capture the "agent caught leakage / test-set tuning" moment in the session log; screenshots + README pass. |
| 4:00–4:45 | Dry-run the demo | Run `docs/DEMO_SCRIPT.md` once end to end. Re-seed so it's deterministic. Record the 1-minute video. |
| 4:45–5:00 | **Submit** | Public repo, live URL, 1-min video, brief, rubric, session log. Confirm repo is public and all teammates added. |
| 6:15 PM | Finalists announced | If picked: 3-min live demo + 1–2 min Q&A using the single provided intro slide. |

## Submission checklist (have these ready before 5:00)

- [ ] Public GitHub repo URL (judges-internal; must contain ALL demoed code).
- [ ] Live Worker URL responding (this is `LABMATE_PUBLIC_URL`).
- [ ] 1-minute demo video showing only what you built today.
- [ ] `docs/BRIEF.md` and `docs/RUBRIC.md` linked.
- [ ] Session log showing the agent catching/correcting an issue.
- [ ] All team members added on the submission page.

## Risk controls

- **Modal/XGBoost dependency pain** → stick to sklearn (logistic, random forest,
  HistGradientBoosting). Only add XGBoost/LightGBM if setup is smooth.
- **Cloudflare time sink** → D1 + a single Worker is enough; Durable Object live stream
  is a nice-to-have, not required for the rubric.
- **Running over** → the rubric's `required` checks are the bar. Skip `required:false`
  items (e.g. fully faceted `query_runs`) if time is short.
