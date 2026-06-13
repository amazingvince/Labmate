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
| Live URL | ✅ | https://amazingvince.com |
| Session log | ✅ | `submission/SESSIONS.md` + redacted `submission/session-logs/` |

## Proven now
- `npm run test:agent` — 4/4 pass, incl. the self-correction loop (leaky launch
  rejected → corrected rerun → report → done). **This is the demo's core, and it's real.**
- Managed Agent + Environment created against the real Anthropic API (IDs in `.env`).
- Cockpit built (`apps/cockpit/dist`).

## What's left
1. ✅ ~~Commit demo code~~ — committed + pushed to `integration` (`apps/agent-runtime/`, `scripts/demo_e2e.mjs`, `docs/GOAL_E2E.md`).
2. ✅ ~~Deploy to a live URL~~ — live at **https://amazingvince.com**.
3. ✅ ~~Cleanup pass~~ — removed overlay-installer + zip/scaffold cruft; rewrote README product-first.
4. ⬜ **Merge `integration → main`** so the public default branch has the full build (needs your OK — auto-mode won't push to main unprompted).
5. ⬜ **Record the 1-min video.** Shot-list in [`submission/README.md`](../submission/README.md); lean on the proven `npm run test:agent` self-correction moment.
6. ⬜ **After the event: rotate `ANTHROPIC_API_KEY` + Modal tokens** (plaintext in local `.env` during the build).

## Scoring angle (what to say in the video / finals)
- **Impact (35%)**: back-office DS workflow (weeks → live), agent-native evidence ledger vs AutoML.
- **Demo (35%)**: live cockpit + the agent catching planted leakage/test-set tuning and rerunning corrected.
- **Opus 4.8 (15%)**: Opus does planning, leakage reasoning, critique, NL-feedback → structured constraint.
- **Orchestration (15%)**: one `/goal`, `npm run guard` + `/api/grade` verify "done" with no human.
