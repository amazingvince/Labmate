# UI backlog — Autopilot DS

Owner: UI dev. Build to [`API_CONTRACT.md`](./API_CONTRACT.md). You are **fully
unblocked from the backend**: run `python mock_backend.py`, open
`http://localhost:8000`, and build against the real contract shapes — no API key.
Starting point is `frontend/index.html` (vanilla JS, polls `/api/state`).

Core rule: **the UI renders entirely from `GET /api/state`** and only ever sends the
four commands. Never assume more than the contract; ignore unknown fields.

Legend: **S** ≈ <1h · **M** ≈ 1–2h · **L** ≈ 2–4h. ★ = on the critical path.

---

### UI-0 · Shell + layout against the mock ★  — S
- Header (brand, status pill, Start, Stop) + two panels: **Agent activity** (left),
  **Experiment leaderboard** (right).
- Boots against `mock_backend.py`.
- **Done:** page renders; layout holds; mock reachable.
- Refs: contract §3 (mock).

### UI-1 · Polling loop + status ★  — S
- Poll `GET /api/state` every ~800 ms; tolerate failures (backend not up) silently.
- Map `status` → status pill text + color and Start/Stop enabled state per the
  `status` table.
- **Done:** the pill tracks the mock through `running` → `waiting` → `done`; buttons
  enable/disable correctly.
- Depends: UI-0. Refs: contract §2.3 (`status`).

### UI-2 · Activity feed ★  — M
- Render `feed[]` newest-last; one row per item with a `kind` tag
  (`agent`/`tool`/`experiment`/`system`/`error`), distinct styling per kind.
- **HTML-escape** all `text`. Auto-scroll only when already at the bottom.
- **Done:** the mock's narration, tool calls, and experiment lines stream in
  readably; long text wraps; no scroll-jacking when the user scrolls up.
- Depends: UI-1. Refs: contract §2.3 (`feed`).

### UI-3 · Experiment leaderboard ★  — M
- Render `experiments[]` as a table: name, model, **headline metric**, validation.
- Headline metric = first of `auc`→`roc_auc`→`f1`→`accuracy`, else first key.
- Highlight the **best** (highest headline metric **among non-leaky** rows); show a
  `best` pill. Flag `leakage_suspected` rows with a `leak?` pill + tint.
- Empty state when none.
- **Done:** against the mock, the leaking ~0.99 row is flagged and **not** chosen as
  best; the clean ~0.84 row becomes best once logged.
- Depends: UI-1. Refs: contract §2.3 (`experiments`, headline metric).

### UI-4 · Run / Stop controls ★  — S
- Start → `POST /api/run` (disable while `running`/`waiting`); Stop →
  `POST /api/stop`.
- Reflect 409 from `/api/run` gracefully (already running).
- **Done:** Start launches the mock run; Stop ends it; buttons obey status.
- Depends: UI-1. Refs: contract §2.1, §2.4.

### UI-5 · Steering box ★  — S
- Textarea + Send → `POST /api/steer {message}`; Enter sends, Shift+Enter newline;
  clear on send; ignore empty.
- **Done:** sending a steer shows the mock's acknowledgement in the feed.
- Depends: UI-1. Refs: contract §2.1, §2.4.

### UI-6 · Checkpoint modal ★  — L
The signature moment. When `checkpoint` is non-null and its `id` is new:
- Open a modal showing `summary`, `proposed_action`, `rationale`, plus a feedback
  textarea.
- **Approve & proceed** → `POST /api/checkpoint {id, decision:"approve"}`.
- **Request changes** → `POST /api/checkpoint {id, decision:"reject", feedback}`.
- Close on submit; dedupe by `id` (don't reopen the same checkpoint each poll);
  ignore unknown fields on the object.
- **Done:** against the mock, the "drop the leak" checkpoint pops; Approve resumes
  the run (next poll: clean best appears, status → `done`); Reject sends feedback.
- Depends: UI-1. Refs: contract §2.2, §2.4.

### UI-7 · Empty/error/done states + polish ★  — M
- First-load empty states for feed + leaderboard; surface the last `error` feed item
  when `status === "error"`; clear visual for `done`.
- Spacing, typography, responsive down to a laptop width; dark theme legible.
- **Done:** the app looks demo-ready in every status; nothing renders raw/undefined.
- Depends: UI-2…UI-6.

### UI-8 · Integration pass with the real backend ★  — S
- Point at `backend/app.py` (live key) instead of the mock; walk the **Definition of
  Done** (contract §4); fix any rendering gaps from real data.
- **Done:** all §4 UI-visible checkboxes pass against the real agent.
- Depends: UI-7 + BE-7.

---

## Stretch (post-demo)
- **UI-S1 — run summary card:** when `State.summary` exists (BE-S3), render a closing
  provenance card (best model, why, what was rejected). Big finish for judges.
- **UI-S2 — SSE feed:** consume `GET /api/stream` (BE-S2) for token-level streaming;
  keep `/api/state` for initial load + reconnect; dedupe by event id.
- **UI-S3 — experiment detail:** click a leaderboard row → side panel with full
  params, hypothesis, notes, metrics.
- **UI-S4 — metric chart:** small AUC-over-experiments sparkline above the table.
- **UI-S5 — light/dark toggle** and keyboard shortcuts (Enter on the modal = approve).

## Build-without-backend checklist
- [ ] `mock_backend.py` running on :8000.
- [ ] Every screen state reachable via the mock script: `idle` → `running` →
      `waiting` (checkpoint) → `running` → `done`, plus `stopped` (Stop) and
      `error` (temporarily make the mock raise to test the error path).
- [ ] Nothing in the UI references Anthropic, sessions, or sandboxes — only the five
      endpoints and the `State` object.
