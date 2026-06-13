# Autopilot DS — build guide & API contract

This is the **shared spec** for the two parallel workstreams:
- [`BACKLOG_backend.md`](./BACKLOG_backend.md) — Flask + Managed Agents integration
- [`BACKLOG_ui.md`](./BACKLOG_ui.md) — the single-page web UI

Both build to the contract below. Freeze the contract first; then the two streams
proceed independently.

---

## 1. How the split works

The UI and backend touch each other through **exactly five HTTP endpoints** and
**one polled state object**. The UI never imports the Anthropic SDK, never knows a
sandbox or a session exists. It does two things forever:

1. **Reads** `GET /api/state` on a timer (~800 ms) — this is the single source of
   truth for everything on screen.
2. **Sends commands** (`run`, `steer`, `checkpoint`, `stop`) that mutate backend
   state; the result shows up on the next poll.

Because of that, the two devs are unblocked the moment the contract is agreed:

```
        ┌─────────────┐   GET /api/state (poll)   ┌──────────────────────┐
        │   Web UI    │ ───────────────────────►  │   Backend (Flask)    │
        │ (BACKLOG_ui)│ ◄───────────────────────  │ (BACKLOG_backend)    │
        │             │   POST run/steer/         │   drives the Managed │
        │             │        checkpoint/stop    │   Agents session     │
        └─────────────┘                           └──────────────────────┘
              │                                              │
              │ build against ────────────────────────────► mock_backend.py
              │ (no API key needed)                          (serves the contract)
```

**The UI dev runs `mock_backend.py`** (below) and gets a realistic, scripted run —
feed events accumulate, experiments land on the leaderboard, a checkpoint fires —
all without an API key or the real agent. **The backend dev** builds the real thing
behind the same contract and tests with `curl` + a live key.

---

## 2. The contract

Base URL (dev): `http://localhost:8000`. All request/response bodies are JSON
(`Content-Type: application/json`). `GET /api/state` is cheap and safe to poll.

### 2.1 Endpoints

| Method | Path              | Purpose                          | Body (in)                                  | 200 (out)        | Errors |
|--------|-------------------|----------------------------------|--------------------------------------------|------------------|--------|
| `GET`  | `/`               | Serve the SPA (`index.html`)     | —                                          | HTML             | —      |
| `GET`  | `/api/state`      | Full UI state (poll this)        | —                                          | `State` (§2.2)   | —      |
| `POST` | `/api/run`        | Start a new run                  | `{}`                                       | `{"ok": true}`   | `409 {"error"}` if a run is already `running`/`waiting` |
| `POST` | `/api/steer`      | Send a steering instruction      | `{"message": string}`                      | `{"ok": true}`   | `400 {"error"}` if `message` empty |
| `POST` | `/api/checkpoint` | Resolve the pending checkpoint   | `{"id": string, "decision": "approve"\|"reject", "feedback"?: string}` | `{"ok": true}` | `400` bad `decision`; `404 {"error"}` unknown `id` |
| `POST` | `/api/stop`       | Stop the current run             | `{}`                                       | `{"ok": true}`   | —      |

### 2.2 The `State` object (`GET /api/state`)

The whole UI renders from this. Fields are always present; lists may be empty;
`checkpoint` is `null` unless the agent is waiting on a decision.

```json
{
  "status": "running",
  "session_id": "sesn_01ABC...",
  "feed": [
    { "ts": 1718304012.41, "kind": "system",     "text": "Sandbox ready. Starting session." },
    { "ts": 1718304018.02, "kind": "agent",      "text": "Loading churn.csv and checking the target balance." },
    { "ts": 1718304021.66, "kind": "tool",       "text": "Bash" },
    { "ts": 1718304040.19, "kind": "experiment", "text": "baseline logistic — auc=0.731" }
  ],
  "experiments": [
    {
      "id": "a1b2c3d4",
      "ts": 1718304040.19,
      "name": "baseline logistic",
      "model_type": "LogisticRegression",
      "params": { "C": 1.0 },
      "metrics": { "auc": 0.731, "accuracy": 0.70 },
      "cv_strategy": "5-fold stratified",
      "hypothesis": "establish a baseline",
      "leakage_suspected": false,
      "notes": ""
    }
  ],
  "checkpoint": null
}
```

When the agent calls `request_approval`, `status` becomes `"waiting"` and
`checkpoint` is populated:

```json
{
  "status": "waiting",
  "checkpoint": {
    "id": "9f8e7d6c",
    "summary": "Drop a leaking feature and re-run",
    "proposed_action": "Remove days_since_cancellation (only populated post-churn) and re-fit the GBM.",
    "rationale": "GBM hit 0.992 AUC; the gain comes entirely from days_since_cancellation, which is unavailable at prediction time."
  }
}
```

> The backend may include extra internal fields on `checkpoint` (e.g. a
> `tool_use_id`). **The UI must ignore unknown fields** — do not assume the object
> is exactly these keys.

### 2.3 Field reference

**`status`** (enum):

| value     | meaning                                   | UI behavior                                  |
|-----------|-------------------------------------------|----------------------------------------------|
| `idle`    | no run yet / before first start           | Start enabled, Stop disabled                 |
| `running` | agent is working                          | feed live; Start disabled, Stop enabled      |
| `waiting` | paused at a checkpoint (`checkpoint` set) | modal open; Stop enabled                     |
| `done`    | run finished cleanly                      | Start enabled; (optional) show summary       |
| `error`   | backend/agent error (see `feed`)          | Start enabled; surface last error feed item  |
| `stopped` | user stopped the run                      | Start enabled                                |

**`feed[]` item:**

| field  | type   | notes                                                              |
|--------|--------|--------------------------------------------------------------------|
| `ts`   | number | epoch seconds (float). UI may format or ignore.                    |
| `kind` | string | one of `agent` \| `tool` \| `experiment` \| `system` \| `error`    |
| `text` | string | display text. UI must HTML-escape it.                              |

**`experiments[]` item** (mirrors the `log_experiment` tool input + backend keys):

| field               | type    | required | notes                                                  |
|---------------------|---------|----------|--------------------------------------------------------|
| `id`                | string  | backend  | stable per experiment                                  |
| `ts`                | number  | backend  | epoch seconds                                          |
| `name`              | string  | yes      | short label                                            |
| `model_type`        | string  | yes      | e.g. `GradientBoosting`                                |
| `metrics`           | object  | yes      | e.g. `{"auc":0.83,"accuracy":0.79}` (held-out scores)  |
| `hypothesis`        | string  | no       | what was tested                                        |
| `params`            | object  | no       | flat hyperparameters                                   |
| `cv_strategy`       | string  | no       | e.g. `5-fold stratified`                               |
| `leakage_suspected` | boolean | no       | UI flags these and excludes them from "best"           |
| `notes`             | string  | no       | freeform                                               |

**Headline metric** (UI sort/highlight): use the first present of
`auc` → `roc_auc` → `f1` → `accuracy`; else the first key in `metrics`.

**`checkpoint`** (or `null`):

| field             | type   | notes                                  |
|-------------------|--------|----------------------------------------|
| `id`              | string | pass back to `POST /api/checkpoint`    |
| `summary`         | string | one line: the decision being asked     |
| `proposed_action` | string | what the agent will do if approved     |
| `rationale`       | string | the evidence/why                       |

### 2.4 Command semantics

- **`/api/run`** — resets all state and starts a fresh run. Reject (409) if one is
  already `running`/`waiting`.
- **`/api/steer`** — the `message` reaches the agent as a priority instruction. It
  may not take effect until the agent's current step finishes; that's expected.
- **`/api/checkpoint`** — `approve` lets the agent proceed; `reject` returns the
  `feedback` to the agent as change-requests it must incorporate. After this call,
  `status` returns to `running` and `checkpoint` becomes `null` (on the next poll).
- **`/api/stop`** — ends the run; `status` becomes `stopped`. Idempotent.

### 2.5 Conventions
- Errors are `{ "error": "<human-readable reason>" }` with a 4xx/5xx status.
- The UI treats `GET /api/state` failures as transient (backend not up yet) and
  keeps polling.
- No auth in the MVP (localhost). Don't add tokens unless you deploy.

---

## 3. Running the mock (UI dev starts here)

`mock_backend.py` implements this entire contract with a scripted run, so the UI is
buildable with zero Anthropic setup.

```bash
pip install flask flask-cors
python mock_backend.py            # serves on http://localhost:8000
# open http://localhost:8000  →  click Start  →  watch the scripted run + checkpoint
```

The script: baseline (~0.73) → GBM (~0.81) → a leaking GBM (~0.99, flagged) →
**checkpoint** asking to drop the leak → on approve, a clean best model (~0.84) →
`done`. `/api/steer` appends an acknowledgement; `/api/stop` ends it. This is the
same sequence the real backend produces, so anything that looks right against the
mock looks right against the real agent.

---

## 4. Definition of done (the integration)

The streams meet here. The demo is "done" when, against the **real** backend:

- [ ] Start → feed shows sandbox provisioning, data load, baseline within ~1 min.
- [ ] Experiments appear on the leaderboard live, sorted, with a highlighted best.
- [ ] A steering message visibly changes what the agent does next.
- [ ] The leak is caught: a `waiting` checkpoint appears with a clear rationale.
- [ ] Approve → agent drops the feature, re-runs, leaderboard settles on an honest
      best (flagged clean); status reaches `done`.
- [ ] Reject + feedback → agent incorporates the feedback instead.
- [ ] Stop ends the run cleanly at any point.

---

## 5. Suggested hackathon timeline

| Time      | Backend                                            | UI                                                  |
|-----------|----------------------------------------------------|-----------------------------------------------------|
| Hour 0    | **Agree & freeze the contract (this doc) together. Ship `mock_backend.py`.** | Pull the mock; get the shell rendering against it. |
| Hours 1–2 | MA bootstrap: agent + environment + session live   | Polling + status + activity feed                    |
| Hours 2–4 | Event stream → feed; `log_experiment` → leaderboard | Leaderboard (sort/best/leak); run + stop controls   |
| Hours 4–6 | `request_approval` checkpoint loop; steer; stop     | Checkpoint modal; steering box; empty/error states  |
| Hours 6–7 | **Integrate against the real backend**; verify `# [MA]` field names | Integrate; polish; stretch (summary card)   |
| Hour 7+   | Stretch: trackio persistence / SSE / run summary   | Stretch: SSE, run summary, responsive               |

Contract changes after Hour 0 must be agreed by both devs and edited **here first**.
