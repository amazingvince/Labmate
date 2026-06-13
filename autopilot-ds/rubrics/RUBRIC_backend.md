# Rubric — Backend stream

How the backend stream is graded and gated. **Gating** rows must all pass for the
work to count as done — the `/goal` and the `Stop` hook enforce these. Weights give a
0–100 quality score for self/peer review. Build target: [`API_CONTRACT.md`](../API_CONTRACT.md).

The backend is fortunate: most of its rubric is **machine-checkable** by
`tests/test_contract_e2e.py` against a live backend.

| # | Criterion | Weight | Gating | How it's checked |
|---|-----------|:-----:|:------:|------------------|
| B1 | **Contract surface present** — five endpoints, the `State` shape, the status vocabulary, the 409/400/404 input guards, the two custom tools declared | 10 | ✅ | `bash scripts/gate.sh backend` (static) — also enforced by the Stop hook |
| B2 | **Live run reaches `done`** — start → sandbox provisions → baseline → iterates → finishes on its own | 20 | ✅ | `test_contract_e2e.py` against the real backend |
| B3 | **Experiments logged live** — each trained model appears in `experiments[]` with `name`, `model_type`, and held-out `metrics`; agent continues after each log | 15 | ✅ | `test_contract_e2e.py` (shape + count) |
| B4 | **Leakage checkpoint round-trip** — agent's review flags the leak, surfaces a `waiting` checkpoint with a clear rationale; approve → agent drops the feature; reject+feedback → agent incorporates it | 20 | ✅ | `test_contract_e2e.py` (checkpoint appears, 400/404 validation, approve→honest best > 0.71) |
| B5 | **Steering + stop** — a `user.message` mid-run reaches the agent; `/api/stop` ends the run cleanly from `running` or `waiting`; idempotent | 10 | ✅ | `test_contract_e2e.py` (steer 400/200, stop 200) + manual mid-run steer |
| B6 | **`# [MA]` field names verified** — every Managed Agents call confirmed against the beta docs; any changed name noted in a short `MA_NOTES.md` | 10 | — | code review + the notes file |
| B7 | **Error surfacing** — a forced failure shows as `status:"error"` + an `error` feed item, never a silent dead driver thread | 5 | — | manual: `MOCK_FORCE_ERROR=1` analog / kill a dependency and observe |
| B8 | **Code quality** — `Store` abstraction intact and swappable (toward trackio), SDK calls isolated, no contract drift | 10 | — | review against the scaffold's structure |

**Definition of done (gating):** B1–B5 all pass → `scripts/gate.sh backend` exits 0
**and** `python tests/test_contract_e2e.py http://localhost:8000` exits 0 against the
real backend.

**Anti-gaming note:** B2–B5 are verified by an external HTTP test, not the agent's
own claim. Do not hardcode `/api/state` responses to satisfy the test — the test
drives a real run (start → checkpoint → approve → finish) and a faked backend that
returns canned state will fail the steering/stop and double-start guards. The point
is a working integration, not a green light.
