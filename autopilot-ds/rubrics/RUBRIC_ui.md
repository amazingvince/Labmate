# Rubric — UI stream

How the UI stream is graded and gated. **Gating** rows must all pass for the work to
count as done. Build and verify against the mock (`python mock_backend.py`).

Honest asymmetry vs the backend: the UI's contract *structure* is machine-checkable
(`scripts/gate.sh ui`), but its *behavior* is visual — you confirm it by loading the
mock and clicking through every state. The Stop hook enforces the structural floor;
the visual rows are confirmed by the agent against the running mock and signed off by
the human at integration.

| # | Criterion | Weight | Gating | How it's checked |
|---|-----------|:-----:|:------:|------------------|
| U1 | **Contract structure** — reads `/api/state` on a timer; uses exactly the five endpoints; renders feed text safely (escaped/`textContent`); a checkpoint modal with approve + reject is wired | 15 | ✅ | `bash scripts/gate.sh ui` (static) — also the Stop hook |
| U2 | **State coverage** — every `status` renders correctly: `idle`, `running`, `waiting`, `done`, `error`, `stopped`; Start/Stop enable per the status table | 20 | ✅ | visual vs mock (incl. `MOCK_FORCE_ERROR=1` for the error path, Stop for `stopped`) |
| U3 | **Checkpoint modal** — shows `summary`, `proposed_action`, `rationale`; **Approve** posts `decision:"approve"`; **Request changes** posts `decision:"reject"` + `feedback`; modal closes on submit; same checkpoint isn't reopened every poll (dedupe by `id`); unknown fields ignored | 20 | ✅ | visual vs mock (approve resumes; reject sends feedback) |
| U4 | **Leaderboard** — table of experiments; **headline metric** (`auc`→`roc_auc`→`f1`→`accuracy`); **best** row highlighted among non-leaky; `leakage_suspected` rows flagged; empty state before any | 20 | ✅ | visual vs mock (the 0.99 row flagged, **not** "best"; clean 0.84 becomes best) |
| U5 | **Activity feed** — newest-last; per-`kind` styling (`agent`/`tool`/`experiment`/`system`/`error`); text HTML-escaped; auto-scroll only when already at bottom | 10 | — | visual vs mock |
| U6 | **Steering box** — Enter sends / Shift+Enter newline; clears on send; ignores empty; shows acknowledgement in the feed | 5 | — | visual vs mock |
| U7 | **Run/Stop controls** — Start launches, disabled while `running`/`waiting`; 409 handled gracefully; Stop ends the run | 5 | — | visual vs mock |
| U8 | **Polish** — legible dark theme, responsive to laptop width, nothing renders raw/`undefined` in any state | 5 | — | visual |

**Definition of done (gating):** U1 passes `scripts/gate.sh ui` (exit 0), **and**
U2–U4 confirmed by clicking through the mock: Start → steer → checkpoint → approve →
`done`, plus the error and stopped states. The agent's final message must confirm each
gating visual row with a one-line note (it has to actually load the mock to do this).

**Anti-gaming note:** U2–U4 require *seeing* the mock behave. Don't claim them from
reading the contract — run `python mock_backend.py`, open the page, and drive it.
