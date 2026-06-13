# Backend backlog — Autopilot DS

Owner: backend dev. Build to [`API_CONTRACT.md`](./API_CONTRACT.md). Starting point
is the scaffold in `backend/app.py` + `backend/agent_config.py`; most tickets are
**verify/harden** rather than build-from-zero. Every Managed Agents call is tagged
`# [MA]` in `app.py`.

Beta: `managed-agents-2026-04-01` (SDK sets it automatically). The real risk is
field names in the beta API — those are the `VERIFY` tickets, do them early.

Legend: **S** ≈ <1h · **M** ≈ 1–2h · **L** ≈ 2–4h. ★ = on the critical path.

---

### BE-0 · Skeleton + Store + `/api/state` + mock ★  — S
The contract's read surface and the UI's unblock.
- Flask app boots; `GET /` serves `frontend/index.html`.
- `Store` holds `status`, `session_id`, `feed[]`, `experiments[]`, `checkpoint`
  behind a lock; `snapshot()` returns the exact `State` shape (§2.2).
- `GET /api/state` returns `snapshot()`.
- Ship `mock_backend.py` (scripted run) so the UI dev starts immediately.
- **Done:** `python mock_backend.py` + open `/` shows a full scripted run incl. a
  checkpoint. `curl /api/state` matches the contract.
- *Scaffolded; mock is the new work.*

### BE-1 · VERIFY: agent + environment + session bootstrap ★  — M
- `agents.create(name, model, system, tools=[agent_toolset + custom tools])`.
  **Confirm** the system-prompt param (`system` vs `system_prompt` vs
  `instructions`) and the custom-tool wrapper (`"type": "custom"` and that custom
  tools live in the same `tools` array as `agent_toolset_20260401`).
- `environments.create()` → a cloud sandbox (confirm default args).
- `sessions.create(agent, environment_id, title)`; store `session_id`; set
  `status="running"`.
- **Done:** starting a run yields a real `session_id` in `/api/state` and the feed
  logs "Sandbox ready / Session started." No exceptions.
- Depends: BE-0. Refs: contract §2.1, §2.3 (`status`).

### BE-2 · VERIFY: event stream → feed ★  — L
`_drain_stream_to_idle()`: open the stream **before** sending the kickoff, then:
- `agent.message` → append `agent` feed item (joined text blocks).
- `agent.tool_use` → append `tool` feed item (the tool name).
- `session.error` → append `error` feed item.
- `session.status_idle` / `session.status_terminated` → return `done` on
  `end_turn`, else `idle-empty` (paused).
- **Confirm** event field access (`event.type`, `event.content[].text`,
  `event.name`, `stop_reason.type`).
- **Done:** a run streams agent narration + tool calls into the feed in real time
  and reaches `done` on its own.
- Depends: BE-1. Refs: contract §2.3 (`feed`).

### BE-3 · `log_experiment` custom tool → leaderboard ★  — M
- On `agent.custom_tool_use` with `name == "log_experiment"`: write
  `Store.add_experiment(input)` (adds `id`,`ts`); append an `experiment` feed item.
- Immediately reply `user.custom_tool_result` (`tool_use_id`, `content:"logged"`)
  so the agent continues.
- **Confirm** the custom-tool event name + the `tool_use_id`/`content` reply shape.
- **Done:** every model the agent trains appears in `experiments[]` with
  `name/model_type/metrics`, and the agent keeps working after each log.
- Depends: BE-2. Refs: contract §2.3 (`experiments`).

### BE-4 · `request_approval` checkpoint loop ★  — L
The human-in-the-loop. On `agent.custom_tool_use` with `name == "request_approval"`:
- `Store.open_checkpoint({summary, proposed_action, rationale, tool_use_id})`;
  set `status="waiting"`.
- **Block the driver thread** on a `threading.Event` until resolved.
- On resolve: reply `user.custom_tool_result` with `"APPROVED…"` (approve) or
  `"CHANGES REQUESTED: <feedback>"` (reject); set `status="running"`.
- **Done:** the agent's approval request surfaces as a `waiting` checkpoint;
  resolving it unblocks the agent with the right message; reject feedback reaches
  the agent.
- Depends: BE-3. Refs: contract §2.2, §2.4.

### BE-5 · `POST /api/checkpoint` ★  — S
- Validate `decision ∈ {approve, reject}` (400 else); resolve the matching
  checkpoint (404 if `id` unknown); store `feedback`; signal the Event.
- **Done:** the endpoint unblocks BE-4; returns `{"ok":true}`; bad input → 400/404
  per contract.
- Depends: BE-4.

### BE-6 · Steering: `POST /api/steer` + forwarding ★  — M
- Endpoint validates non-empty `message` (400 else), queues it.
- Driver drains the queue between turns and sends `user.message` events.
- **Done:** a steer sent mid-run visibly changes the next thing the agent does; a
  `system` feed item records it.
- Depends: BE-2. Refs: contract §2.4.

### BE-7 · Stop: `POST /api/stop`  — S
- Set the stop flag (driver loop exits; releases any waiting checkpoint), attempt
  `sessions.interrupt(session_id)` (**confirm** vs delete; wrap in try/except), set
  `status="stopped"`.
- **Done:** Stop ends the run from `running` or `waiting`; idempotent; no hang.
- Depends: BE-1. Refs: contract §2.4.

### BE-8 · Error surfacing + run guard  — S
- Driver wraps everything; on exception set `status="error"` + `error` feed item.
- `/api/run` returns 409 if `status ∈ {running, waiting}`.
- **Done:** a forced failure shows as `error` (not a silent dead thread); double-
  start is rejected.
- Depends: BE-0.

### BE-9 · Sandbox package check  — S
- Ensure the system prompt instructs `pip install scikit-learn pandas` on miss; if
  the cloud sandbox lacks them, confirm the agent installs and proceeds (~10s).
- **Done:** a cold run trains models without manual intervention.
- Depends: BE-1.

### BE-10 · Integration pass with the real UI ★  — M
- Run `backend/app.py` (not the mock) behind the live UI; walk the **Definition of
  Done** (contract §4) end-to-end; fix any field-name mismatches surfaced.
- **Done:** all §4 checkboxes pass on a live key.
- Depends: BE-1…BE-7 + UI-7.

---

## Stretch (post-demo)
- **BE-S1 — trackio persistence:** back `Store` with trackio (wandb-API-compatible,
  SQLite, ships an agent CLI) so runs survive restarts + you get its dashboard. Keep
  the `Store` method signatures; swap the internals.
- **BE-S2 — SSE:** replace polling with a `GET /api/stream` SSE endpoint pushing
  feed/experiment/checkpoint deltas (token-level feed). Contract gains one endpoint;
  `/api/state` stays for reconnect/initial load.
- **BE-S3 — run summary:** at `done`, have the agent emit a provenance footer (best
  model, why, what was rejected and why); add `summary` to `State`.
- **BE-S4 — self-hosted sandbox:** move tool execution to your own Modal/Cloudflare
  sandbox so data never leaves your perimeter (agent loop stays on Anthropic).
- **BE-S5 — Plan B logging path:** if custom tools misbehave, add
  `POST /api/experiments` and have the agent `curl` results; switch the checkpoint
  to an `always_ask` permission policy + `user.tool_confirmation`. UI unchanged.

## Risk register (do the VERIFY tickets first)
| Risk | Ticket | Fallback |
|------|--------|----------|
| Custom-tool declaration shape differs | BE-1 | BE-S5 (HTTP logging + permission gate) |
| `custom_tool_use`/`custom_tool_result` field names differ | BE-3 | BE-S5 |
| Stream pauses vs ends on idle (resume semantics) | BE-2 | reopen-stream loop already in scaffold; confirm |
| `agents.create` param names differ | BE-1 | check Agent setup doc |
| Stop method name differs | BE-7 | local flag already exits the loop |
