# Labmate — Claude Build Day submission package

**Labmate is an agent-native data science harness.** The human gives business
judgment; a real **Anthropic Managed Agent (Opus 4.8)** plans, runs, critiques,
documents, and iterates on tabular ML experiments. The **evidence ledger**
(hypothesis → experiment → evidence → decision) is the product.

> The human gives judgment, a real managed agent does the science in sandboxes, and
> every hypothesis, run, critique, and decision is captured in an agent-native ledger
> you can steer live.

## Submission checklist
| Required | Status | Link |
|---|---|---|
| Public repo | ✅ | https://github.com/amazingvince/Labmate |
| Brief | ✅ | [`docs/BRIEF.md`](../docs/BRIEF.md) |
| Rubric (machine-gradable) | ✅ | [`docs/RUBRIC.md`](../docs/RUBRIC.md) · [`docs/rubric.json`](../docs/rubric.json) |
| Orchestration / workflow | ✅ | [`docs/PARALLEL_BUILD.md`](../docs/PARALLEL_BUILD.md) · [`docs/GOAL_E2E.md`](../docs/GOAL_E2E.md) · `.claude/workflows/run-study.js` |
| Session log | ✅ | [`SESSIONS.md`](SESSIONS.md) + `session-logs/*.jsonl` (redacted) |
| **Live URL** | ✅ | **https://amazingvince.com** |
| 1-min demo video | ⬜ TODO | see shot-list below |

## What's real (not stubbed)
- **Managed Agent + cloud Environment** created against the real Anthropic API
  (beta `managed-agents-2026-04-01`); IDs persisted in `.env`.
- **Control plane** deployed on Cloudflare (Worker + D1 + R2 + Durable Object).
- **Cockpit** built and served (`apps/cockpit/dist`).
- **Modal runner** is the only experiment executor; it physically strips banned columns from the data server-side before training (they never reach the model even if a manifest lists them) and rejects `tune_on=test` manifests.
- **Self-correction loop passes in CI:** `npm run test:agent` → leaky launch rejected → corrected rerun → report → done.

## How to verify "done" without a human
```bash
npm run guard            # schema-check + lint + tests + agent smoke test
npm run test:agent       # the self-correction loop, isolated
# POST /api/grade against docs/rubric.json → verdict=done
```

## 60-second demo shot-list
1. **(0–8s)** Live cockpit at **amazingvince.com** — the four-pane mission control + evidence ledger. *(Impact)*
2. **(8–20s)** Create a study / show the seeded `sla_tickets` study: data contract, target=`breached_sla`, candidate leakage columns flagged. *(Demo)*
3. **(20–35s)** The agent catches leakage and **reruns corrected** — run `npm run test:agent` on screen, point to "leaky launch rejected → corrected rerun → done." *(Demo + Orchestration)*
4. **(35–48s)** Inject NL feedback "recall matters more than precision, keep FPR ≤ 20%" → parsed into a structured constraint that shapes the next experiment. *(Opus 4.8)*
5. **(48–60s)** Final model card with provenance + reproducible command; `/api/grade` → **done**. "Done, verified without a human." *(Impact + Orchestration)*

## Post-event housekeeping
- **Rotate `ANTHROPIC_API_KEY` and the Modal tokens** — they were in `.env` locally during the build.
- Drop build cruft before judges browse: `labmate-starter.zip`, `labmate-e2e-overlay.zip`, `labmate_hackathon_scaffold.html`.
