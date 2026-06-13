# Labmate — Build Day runbook (start to finish)

This is your single operating manual for the day. It assumes you've unzipped the
scaffold into a folder and have a terminal open in it. Times line up with the
event schedule (doors 9:00, hack starts 10:30, submissions 5:00 sharp).

> The scaffold's job is to let **Claude Code do the building** while you steer.
> Your job is mostly: fill keys, paste the kickoff, approve at checkpoints, and
> make sure the "caught a bug" moment lands on camera.

---

## 0. Mental model (read once, 60 seconds)

Labmate is a cockpit for the loop **hypothesis → experiment → evidence → decision**.
You give business judgment; Claude profiles data, plans experiments, runs them in
a sandbox, critiques its own results, and writes a reproducible report. Everything
it believes, does, and is corrected on is captured in an **evidence ledger**.

The whole build is governed by three machine-checkable things, which is also your
Orchestration story for judging:

1. **A rubric it grades itself against** — `docs/rubric.json` (25 checks).
2. **A test suite + schema-check** — `npm run guard`.
3. **A live URL** — the deployed Cloudflare Worker cockpit.

"Done" = `grade_study_against_rubric` returns all required checks passing.

---

## 1. First 10 minutes — get the scaffold green locally

```bash
npm run setup
```

This is idempotent. It will:
- create `.env` from `.env.example` (if missing) and tell you which **required**
  keys are still blank (without printing any values),
- `npm install`,
- generate the deterministic demo dataset if absent,
- run the `schema-check` guardrail,
- print your next step.

If `npm install` fails on venue Wi-Fi, that's fine — re-run `npm install` later;
the rest of setup still completes.

---

## 2. Fill in your keys (`.env`)

Open `.env` and fill the six required keys. `docs/ENV.md` has click-by-click
instructions and links. Short version:

| Key | Where | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | Use the **$500 Build Day credit** key (redeem the link from `#credit-questions`). 24h expiry. |
| `ANTHROPIC_MODEL` | already set | Leave as `claude-opus-4-8` — Opus 4.8 use is scored. |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | `pip install modal` then `modal token new` | Writes `~/.modal.toml` and prints both. |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → right sidebar | |
| `CLOUDFLARE_API_TOKEN` | dash → profile → API tokens | "Edit Cloudflare Workers" template covers Workers/D1/R2/DO. |
| `LABMATE_INTERNAL_TOKEN` | `openssl rand -hex 24` | Shared secret between MCP server and Worker. Not your CF token. |

Keys filled in **after** you deploy (leave blank for now): `MODAL_RUNNER_URL`,
`CLOUDFLARE_D1_DATABASE_ID`, `LABMATE_PUBLIC_URL`.

Then validate everything:

```bash
./scripts/preflight.sh
```

Green preflight = tooling present and required keys set. Fix any ❌ before moving on.

---

## 3. Provision cloud resources (one-time, ~10 min)

You can do these by hand now, or let Claude Code do them in the kickoff. Doing
D1/R2 yourself first tends to be faster:

```bash
# Cloudflare D1 (study/run metadata)
cd apps/web
npx wrangler d1 create labmate
#   -> copy the printed database_id into BOTH .env (CLOUDFLARE_D1_DATABASE_ID)
#      and apps/web/wrangler.toml
npx wrangler d1 execute labmate --file=./schema.sql     # apply the ledger schema

# Cloudflare R2 (artifacts/reports/models)
npx wrangler r2 bucket create labmate-artifacts

# Deploy the Worker cockpit (gives you LABMATE_PUBLIC_URL — your submission URL)
npx wrangler deploy
cd ../..

# Modal runner (sandboxed experiment execution)
pip install modal && modal deploy apps/modal-runner/runner.py
#   -> copy the printed FastAPI URL into .env (MODAL_RUNNER_URL)
```

Re-run `./scripts/preflight.sh`; it should now show `LABMATE_PUBLIC_URL` and
`MODAL_RUNNER_URL` set.

---

## 4. Kick off Claude Code (this is the main event)

Open Claude Code in the repo root. Paste the **entire contents of
`docs/KICKOFF.md`** as your first message. It briefs the model on the contracts
and rules of engagement. Then paste the **headline `/goal` from `docs/GOALS.md`**.

The `.mcp.json` at the repo root registers the Labmate MCP server, and
`.claude/settings.json` wires the hooks (log every run, block destructive
commands, gate Modal launches behind approval). You don't need to do anything for
those — Claude Code loads them automatically.

From here Claude will:
1. Confirm the scaffold builds (`./scripts/preflight.sh`).
2. Fill in the TODOs in `apps/*` and `.claude/workflows/run-study.js` so the
   golden path runs.
3. Execute the loop: profile → plan → **(pause for your approval)** → run →
   critique → rerun → report → grade.

**Your checkpoints.** When Claude pauses for approval (excluding leakage fields,
launching Modal jobs, raising the compute budget), make the call in the cockpit
or by telling Claude. Don't auto-approve compute — the gating is part of the
Safety & control rubric category.

If you'd rather stage it, paste the **Phase 1–4 goals** from `docs/GOALS.md` one
at a time. Phase 1 = one run end to end; Phase 4 = the "caught the bug" moment.

---

## 5. The judges' moment (do not skip)

The bundled dataset has **planted leakage** (`resolved_at`,
`time_to_resolution`, `closed_status`, `agent_notes_final` are all post-outcome)
and the workflow is seeded so the critic catches a **test-set-tuning** mistake.
That self-correction is your single strongest piece of evidence for both Demo
(35%) and Orchestration (15%).

Make sure your session log / screen recording captures:
- the critic flagging the issue ("this run tuned the threshold on the test
  split / these columns aren't available at prediction time"), and
- Claude **rerunning the corrected experiment** and the rubric check
  `caught_an_issue` flipping to pass.

`docs/DEMO_SCRIPT.md` has the exact beat-by-beat.

---

## 6. Keep it honest while it runs — static guardrails

Run these anytime (and they run in CI on every push via
`.github/workflows/guard.yml`):

```bash
npm run guard          # schema-check + lint + smoke tests   (fast, no cloud)
npm run guard:full     # + Python runner lint + pytest
npm run schema:check   # contracts + rubric shape + cross-file consistency
npm test               # rubric-shape + dataset-contract smoke tests
npm run grade -- --study <study_id>   # grade a real study against the rubric
```

What each guardrail protects against:
- **schema-check** — a malformed rubric, a broken JSON schema, or a dangling
  reference (e.g. an agent/skill the rubric assumes exists but doesn't).
- **dataset-contract test** — regenerating the data with the wrong columns or
  losing the planted leakage fields (which would kill the demo).
- **rubric-shape test** — someone reshaping `rubric.json` so `grade_study.py`
  can't read it.
- **determinism check (CI)** — the dataset must regenerate byte-identical, so
  the demo is reproducible.
- **Claude Code hooks** — block `rm -rf`/table drops/R2 deletes and stop any
  Modal launch that lacks a recorded approval or exceeds budget.

---

## 7. Hour-by-hour (mirrors `docs/BUILD_PLAN.md`)

| Time | Focus | Done when |
|---|---|---|
| before 10:30 | Keys + cloud provisioning + green preflight | `./scripts/preflight.sh` all ✅ |
| 10:30–12:00 | Phase 1: one run end to end | `query_runs(study_id)` returns 1 completed run |
| 12:00–1:00 | Phase 2: cockpit renders the study | Worker URL shows the seeded study + a run |
| 1:00–2:00 | Phase 3: workflow drives all phases | one `npm run study` advances through phases |
| 2:00–3:00 | Phase 4: autonomous loop + caught bug | `caught_an_issue` rubric check passes |
| 3:00–4:00 | Polish: resilient UI, README, save session log, seed determinism | demo runs clean twice in a row |
| 4:00–5:00 | Submit | repo public, live URL up, 1-min video, brief, rubric, session log |

---

## 8. Submit (5:00 PM sharp)

Submit at the Cerebral Valley link in the participant guide. Checklist:
- [ ] **Public** GitHub repo (judging requires it).
- [ ] Live URL responding (`LABMATE_PUBLIC_URL`).
- [ ] 1-minute demo video showing the loop **and the caught-bug moment**.
- [ ] `docs/BRIEF.md` (problem, user, what you built, done criteria).
- [ ] `docs/rubric.json` + `docs/RUBRIC.md` (your machine-gradable "done").
- [ ] Session log (the orchestration evidence — show the brief, the rubric, and
      the moment Claude caught and fixed a failure).
- [ ] All teammates added to the submission page.

For the optional Round-2 stage demo: only the provided intro slide is allowed;
spend the 3 minutes on code + product on screen, how you directed Claude, and
the self-correction moment.

---

## 9. Troubleshooting

- **`npm install` fails on venue Wi-Fi** — retry; or `npm run setup --skip-install`
  to finish the rest, then install when the network is better.
- **`preflight.sh` says a key is missing** — fill it in `.env`; never ask Claude
  to invent credentials.
- **Wrangler can't find the DB** — confirm the `database_id` is in *both* `.env`
  and `apps/web/wrangler.toml`, and that you ran the `d1 execute ... schema.sql`.
- **Modal launch denied by a hook** — that's the approval gate working. Record
  the approval (cockpit / tell Claude) and retry. Check `LABMATE_MAX_JOB_SECONDS`
  and the per-study budget if it's a budget denial.
- **`grade_study.py` runs in dry mode** — it needs `LABMATE_PUBLIC_URL` set and
  the control plane reachable; until the Worker is deployed it just lists checks.
- **Dataset looks different after regen** — run the dataset-contract test
  (`npm test`); the generator is seeded and should be byte-identical.
- **Don't wander into non-goals** — no generic dashboard as the product, no
  warehouse/MLOps, no notebook replacement, no medical/education/sports data
  (the last set is banned by the rules). See `docs/GOALS.md`.

---

## 10. The one-sentence pitch (memorize it)

> We built the missing harness for autonomous data science: Claude does the
> profiling, planning, experiment execution, critique, and reporting, while the
> human steers through business feedback — and every hypothesis, metric,
> artifact, and decision is captured in an agent-native experiment tracker.
