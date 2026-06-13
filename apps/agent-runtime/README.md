# Labmate agent runtime

The bridge between an Anthropic **Managed Agents** session and Labmate's own infra
(the Cloudflare control plane + the Modal experiment runner). This is the piece
that turns "an agent that can talk" into "an agent that runs real experiments and
reviews them in a loop while a human steers from the cockpit."

Grounded in the current Managed Agents beta (`managed-agents-2026-04-01`). See
`docs/GOAL_E2E.md` §0 for the verified mental model and doc links.

## What it does

1. **Bootstrap (once):** create ONE versioned **agent** (model `claude-opus-4-8`,
   the DS system prompt, the Labmate **custom tools**, the DS **skills**) and ONE
   cloud **environment**; save their IDs to `.env`. Agents can't be deleted (only
   archived, permanently), so we reuse them — never create-per-study.
2. **Start a session per study:** `sessions.create(agent, environment)`, then send
   the brief + data contract + rubric as a `user.message`.
3. **Hold the event stream:** `sessions.events.stream()`. For each event:
   - text / thinking → forward to the control plane → cockpit (live activity);
   - **custom tool-use → dispatch** to a real handler, return `user.custom_tool_result`;
   - idle / awaiting input → check "done"; if not, nudge the next step.
4. **Custom tool dispatch is the agent's hands:**
   `propose_experiments`, `launch_experiment` (REAL Modal call), `query_runs`,
   `record_critique`, `write_report` — all persisted over the OpenAPI contract.
5. **Done:** if the Outcomes preview is enabled, read its verdict; otherwise call
   `POST /api/grade` against `docs/rubric.json`.

```
POST /agent/start {study_id}          → create session, send brief, start streaming
GET  /agent/{study_id}/stream  (SSE)  → live agent events (control plane proxies to cockpit)
POST /agent/{study_id}/message        → inject a human "suggest changes" message
```

## Files

- `src/anthropic.mjs` — thin SDK wrapper (sets the beta, exposes agents/env/sessions/events).
- `src/bootstrap.mjs` — create the agent + environment, write IDs to `.env`.
- `src/tools.mjs` — the custom-tool *definitions* (names + JSON schemas, from the
  OpenAPI contract) the agent is given.
- `src/dispatch.mjs` — maps each tool-use to a real handler (control plane / Modal).
- `src/loop.mjs` — the session lifecycle: start, stream, dispatch, nudge, finish.
- `src/server.mjs` — the HTTP/SSE surface above.
- `src/config.mjs` — env loading + required-key checks.
- `tests/e2e.smoke.test.mjs` — drives the whole loop with Anthropic + Modal stubbed.

## Run

```bash
# 0. deps (uses the official SDK)
npm install

# 1. one-time: create the agent + environment, save IDs to .env
node src/bootstrap.mjs

# 2. start the runtime
node src/server.mjs        # listens on AGENT_RUNTIME_PORT (default 8betaY)

# 3. smoke test (no real API calls)
npm test

# 4. the deterministic demo against real APIs
npm run demo:e2e           # from repo root
```

> The runtime can also be deployed as a Modal app (a web endpoint + a long-running
> function holding the stream) so you don't need a separate host at the hackathon.
> See `src/server.mjs` for the note.
