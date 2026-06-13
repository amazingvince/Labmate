# Submission plan — Claude Build Day (due 5:00 PM)

Repo: https://github.com/amazingvince/Labmate (public ✅)

## Required submission artifacts
| Item | Status | Where |
|---|---|---|
| Public GitHub repo | ✅ | amazingvince/Labmate |
| Brief | ✅ | `docs/BRIEF.md` |
| Rubric (machine-gradable) | ✅ | `docs/RUBRIC.md`, `docs/rubric.json`, `/api/grade` |
| Workflow / orchestration | ✅ | `docs/GOAL_E2E.md`, `.claude/workflows/run-study.js`, `npm run guard` |
| 1-min demo video | ❌ | record last |
| Live URL | ❌ | deploy `apps/web` (cockpit + control plane) |
| Session log | ⚠️ | export this session |

## Proven now
- `npm run test:agent` — 4/4 pass, incl. the self-correction loop (leaky launch
  rejected → corrected rerun → report → done). **This is the demo's core, and it's real.**
- Managed Agent + Environment created against the real Anthropic API (IDs in `.env`).
- Cockpit built (`apps/cockpit/dist`).

## Priority order (time-boxed)
1. **Commit + merge everything (10 min).** Untracked demo code (`apps/agent-runtime/`,
   `scripts/demo_e2e.mjs`, `docs/GOAL_E2E.md`) must be on `main`. Merge `integration → main`, push.
2. **Deploy to a live URL (15-20 min).** `apps/web`: D1 migrate, R2 bucket, `wrangler secret put`
   ANTHROPIC_API_KEY / LABMATE_INTERNAL_TOKEN / MODAL_RUNNER_URL, `wrangler deploy`. Set
   `LABMATE_PUBLIC_URL` to the workers.dev URL. Seed the demo study so the URL shows the ledger.
3. **Record the 1-min video (15 min).** Lean on what's proven (DEMO_SCRIPT.md): cockpit +
   the caught-leakage rerun in `npm run test:agent` + `/api/grade` → done.
4. **STRETCH — real end-to-end (riskier).** `modal deploy apps/modal-runner/runner.py` →
   set `MODAL_RUNNER_URL` → `npm run demo:e2e` against real Opus 4.8 + real Modal. Only if 1-3 done.

## Cleanup before submit
- `.env` is gitignored (confirmed) — but **rotate the ANTHROPIC_API_KEY** after the event; it's in plaintext locally.
- Drop build cruft from the repo: `labmate-starter.zip`, `labmate-e2e-overlay.zip`,
  `labmate_hackathon_scaffold.html` (or .gitignore them).

## Scoring angle (what to say in the video / finals)
- **Impact (35%)**: back-office DS workflow (weeks → live), agent-native evidence ledger vs AutoML.
- **Demo (35%)**: live cockpit + the agent catching planted leakage/test-set tuning and rerunning corrected.
- **Opus 4.8 (15%)**: Opus does planning, leakage reasoning, critique, NL-feedback → structured constraint.
- **Orchestration (15%)**: one `/goal`, `npm run guard` + `/api/grade` verify "done" with no human.
