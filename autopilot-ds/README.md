# Autopilot DS — a guidable autonomous data scientist

> **New here? Open [`GETTING_STARTED.md`](./GETTING_STARTED.md)** for the runbook.
> Building it out? [`CLAUDE.md`](./CLAUDE.md) is the project context, the docs are
> [`API_CONTRACT.md`](./API_CONTRACT.md) · [`PARALLEL_BUILD.md`](./PARALLEL_BUILD.md) ·
> [`DEPLOY.md`](./DEPLOY.md).


An MVP of the **autopilot** flow: you set a goal, [Claude Managed
Agents](https://platform.claude.com/docs/en/managed-agents/overview) runs the
agent loop (forming hypotheses, training models, iterating), and a web UI lets you
**watch every experiment land on a live leaderboard** and **steer the agent** —
approving or redirecting it at checkpoints. The splashy moment: the agent catches
a planted data leak, pauses, and asks you what to do.

Built for a hackathon. One backend file, one HTML file.

## Why this is small
Managed Agents runs the brain (the loop, the sandbox, the state, the streaming) on
Anthropic's infra. You don't build an agent loop, a sandbox, or orchestration —
you configure an agent and consume its event stream. The only code here is the
**tracker + the steering surface**, which is the actual product.

The clever bit: **two custom tools are the tracker and the checkpoint.**
- `log_experiment` → the agent calls it per model; your backend writes it straight
  to the leaderboard (no sandbox egress) and returns "logged".
- `request_approval` → the agent calls it before finalizing or when it suspects a
  leak; your backend *holds the tool result* until the human clicks, then returns
  approval or change-requests the agent must incorporate. That hold **is** the
  human-in-the-loop. Permission policies don't apply to custom tools, so the
  agent's real work (bash/sklearn in the sandbox) runs freely on `always_allow`.

## Setup
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...        # an API account with Managed Agents access (on by default in the beta)
python app.py
```
Open **http://localhost:8000**.

## Demo script (about 3 minutes)
1. **Start run.** The feed shows the agent provision a sandbox, generate the churn
   dataset, and train a baseline. A baseline (~0.71–0.78 AUC) lands on the
   leaderboard within a few experiments.
2. **Steer it live.** Type *“try gradient boosting and add target encoding for the
   categorical”* and hit Send. Watch it adapt mid-run — new experiments appear.
3. **The catch (the money shot).** A model scores a suspiciously high AUC (~0.99).
   The agent's leakage review notices `days_since_cancellation` only has values for
   customers who already churned — it's unavailable at prediction time. Instead of
   shipping it, the agent fires a **checkpoint**: a modal asks you to approve
   dropping the feature and re-running.
4. **You guide it.** Click **Approve & proceed** (or **Request changes** and type
   guidance — the agent incorporates it). It drops the leak, re-runs, and the
   leaderboard settles on an **honest** best model (~0.80–0.85 AUC), flagged clean.
5. **The pitch, in one line:** *the value isn't that an agent did data science —
   it's that it did data science you can trust, because the harness caught the
   thing that would have embarrassed you in the readout, and you stayed in control
   the whole time.*

> The leak is planted deterministically in the kickoff task (`agent_config.py`), so
> step 3 happens on every run. To demo on a **real** dataset, remove the data-gen
> block in `KICKOFF_TASK` and mount a CSV at session create via the Files API.

## What's in the box
```
backend/
  app.py            # store + session driver thread + HTTP API  (all SDK calls live here, tagged # [MA])
  agent_config.py   # MODEL, custom-tool schemas, system prompt (DS method), kickoff task
  requirements.txt
frontend/
  index.html        # live feed + leaderboard + steer box + checkpoint modal (vanilla JS, polls /api/state)
```
**HTTP API:** `POST /api/run`, `GET /api/state`, `POST /api/steer`,
`POST /api/checkpoint`, `POST /api/stop`.

## Verify these against the beta docs before/at the hackathon
The Managed Agents API is in beta (`managed-agents-2026-04-01`) and a few field
names may differ from the snippets this was built from. Every spot is tagged
`# [MA]` in `app.py`. In priority order:

1. **Custom tool declaration** (`agent_config.py` `CUSTOM_TOOLS`): the `"type":
   "custom"` value and that custom tools sit in the same `tools` array as
   `agent_toolset_20260401`. → *Tools* and *Agent setup* docs.
2. **Custom tool events** (`app.py`): the event name `agent.custom_tool_use` and the
   reply event `user.custom_tool_result` with `tool_use_id` + `content`.
   → *Session event stream* docs. (If custom tools differ, the Plan B below works.)
3. **System-prompt param** on `agents.create` (`system` vs `system_prompt` vs
   `instructions`). → *Agent setup* docs.
4. **Environment create** defaults for a cloud sandbox. → *Cloud environment setup*.
5. **Stop method** (`sessions.interrupt` vs delete). → *Session operations*. We also
   set a local flag, so Stop ends the driver loop regardless.
6. **Sandbox packages**: if scikit-learn/pandas aren't preinstalled, the agent will
   `pip install` them (the system prompt tells it to) — costs ~10s on first run.

### Plan B if custom tools fight you
Drop the custom tools and have the agent log over HTTP from the sandbox instead:
add a `POST /api/experiments` route, and in the kickoff tell the agent to
`curl` (or `requests.post`) each result to `http://<your-host>/api/experiments`.
For the checkpoint, switch to a permission policy: set `always_ask` on a dedicated
bash command the agent runs to request approval, and resolve it with a
`user.tool_confirmation` event (`result: allow|deny`, `deny_message: <feedback>`).
The UI doesn't change.

## Stretch goals (in rough order of demo payoff)
- **Token streaming** instead of 800ms polling (SSE from the backend) for a snappier
  feed.
- **Run summary card**: at `done`, have the agent write a short provenance footer
  (best model, why, what was rejected and why) and surface it.
- **Persisted tracker**: swap the in-memory `Store` for trackio (it's
  wandb-API-compatible, SQLite-backed, and ships an agent CLI) so runs survive
  restarts and you get its dashboard for free.
- **Real data + self-hosted sandbox**: mount a customer CSV and move tool execution
  into your own Modal/Cloudflare sandbox so data never leaves your perimeter (the
  agent loop still runs on Anthropic).
