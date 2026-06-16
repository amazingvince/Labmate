# Goal — end-to-end: Managed Agent runs real experiments, human steers from the UI

This is the demo. A user gives a problem and a dataset in the cockpit; the backend
spins up an **Anthropic Managed Agent** (real API) with custom tools, MCP, and the
DS skills; the agent proposes experiments that **run in Modal sandboxes** (real);
the agent **reviews the results and loops**; and the cockpit is how the human
watches it happen, suggests changes mid-flight, and gets back the final report and
model.

It builds directly on what you already have (the control plane, the MCP tool
surface, the Modal runner, the cockpit). The **one new component** is the
*agent runtime* — the bridge that runs a Managed Agents session, catches the
agent's custom-tool calls on the event stream, executes them against Modal and
your control plane, and feeds results back.

> Read this whole file, then paste the **Brief** into Claude Code, then the
> **/goal**. The slices at the end are the suggested order; let Claude sequence
> within them.

---

## 0. How Managed Agents actually works (grounding — don't skip)

Verified against the current docs (beta `managed-agents-2026-04-01`). The mental
model that matters for our loop:

- You create **three persisted resources**, in order:
  1. an **Agent** — model, system prompt, **tools**, **mcp_servers**, **skills**
     (these live on the *agent*, not the session). Versioned; sessions pin a version.
  2. an **Environment** — a cloud sandbox config (`config.type: "cloud"`,
     networking). This is *Anthropic's* sandbox where the agent's built-in tools
     (bash, files, code) run.
  3. a **Session** — references one agent + one environment, holds conversation
     state as an **event stream** that outlives the context window.
- You **drive work by sending events** (`user.message`) and **observe by streaming
  events** back (SSE via `sessions.events.stream()`).
- **Custom tools are the integration seam.** When the agent decides to use a tool
  *you* defined (e.g. `launch_experiment`), it emits a tool-use event and the
  session pauses for that tool; you execute it on your own infra and return a
  `user.custom_tool_result` event (`custom_tool_use_id`, `content`, `is_error`).
  **This is how the agent reaches Modal** without us handing it arbitrary compute.
- **MCP servers** attach on the agent; **vaults** (`vault_ids` at session create)
  hold any MCP OAuth/bearer creds, refreshed by Anthropic.
- **Outcomes** (define a success rubric the agent self-evaluates against) is a
  research-preview feature behind an access request. **Design for it, but gate it**
  — our fallback "done" is our own `/api/grade` against `docs/rubric.json`, which
  needs no preview access.
- Headers: every call needs the beta header; the SDK adds it automatically for
  `client.beta.{agents,environments,sessions,vaults}.*`. Set `ANTHROPIC_API_KEY`.

Key constraint to honor in the design: **agents have no delete, only archive, and
archive is permanent** — so the runtime should *reuse* a small number of agents/
environments (created once, by version), not create-per-study.

Primary references (fetch if you need detail):
- Overview: https://platform.claude.com/docs/en/managed-agents/overview
- Quickstart: https://platform.claude.com/docs/en/managed-agents/quickstart
- Sessions: https://platform.claude.com/docs/en/managed-agents/sessions
- Event stream: https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- Tools: https://platform.claude.com/docs/en/managed-agents/tools
- MCP connector: https://platform.claude.com/docs/en/managed-agents/mcp-connector
- Define outcomes: https://platform.claude.com/docs/en/managed-agents/define-outcomes
- Endpoint reference: https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-api-reference.md

---

## 1. Target architecture (what "joined up" means here)

```
  Cockpit (apps/cockpit)
    │  POST /api/studies        (problem + dataset upload)
    │  GET  /api/studies/{id}   (poll the ledger)
    │  GET  /api/studies/{id}/stream   (SSE: live agent activity)
    │  POST /api/feedback       (human "suggest changes" mid-run)
    ▼
  Control plane (apps/web — Cloudflare Worker, D1, R2, DO)
    │  on study create: enqueue a "start agent" job  ─────────────┐
    │  proxies the agent runtime's event stream to the cockpit    │
    ▼                                                              │
  Agent runtime (apps/agent-runtime — NEW)         ◀──────────────┘
    │  1. ensure Agent + Environment exist (once, versioned)
    │  2. sessions.create(agent, environment) for this study
    │  3. send user.message: the brief + data contract + rubric
    │  4. sessions.events.stream():
    │       • text/thinking  → forward to control plane → cockpit
    │       • custom tool-use → DISPATCH (below) → custom_tool_result
    │       • idle/awaiting   → check done; if not, nudge next step
    │  5. on done: pull report+model, mark study complete
    │
    │   custom tool dispatch (the agent's "hands"):
    │     propose_experiments → write hypotheses to control plane
    │     launch_experiment   → POST Modal runner (REAL) → record run
    │     query_runs          → read ledger
    │     record_critique     → write critique/decision
    │     write_report        → render model card → R2
    ▼
  Modal runner (apps/modal-runner — REAL sklearn/optuna jobs)
```

Two services already speak HTTP over your OpenAPI contract; the agent runtime is a
long-lived Node (or Python) process that holds the SSE stream. It can run on Modal
itself (a `modal.App` with a web endpoint + a long-running function) so you don't
need a separate host at the hackathon.

### Where the agent's tools come from
The agent's **custom tools** mirror your existing MCP tool surface — same names,
same JSON shapes from `apps/api-spec/openapi.yaml`. You can wire them two ways;
do **(a)** for the demo and leave (b) as a note:
- **(a) Custom tools handled by the runtime.** Declare them on the agent as custom
  tools; the runtime catches each tool-use on the stream and executes it. Full
  control, easy to log, no extra hop. **Use this.**
- **(b) MCP server.** Point the agent's `mcp_servers` at your deployed
  `apps/mcp-server`. Cleaner separation, but adds an auth/tunnel surface. Optional.

---

## 2. Brief (paste this into Claude Code first)

```
You are extending Labmate to a real end-to-end demo. Today it has a Cloudflare
control plane (apps/web), an MCP tool surface + OpenAPI contract
(apps/api-spec/openapi.yaml), a Modal experiment runner (apps/modal-runner), and a
cockpit (apps/cockpit). They are joined up over the contract.

Build the missing piece and wire the loop with REAL API usage:

GOAL OF THE DEMO: a user enters a problem + uploads a dataset in the cockpit; the
backend starts an Anthropic Managed Agent (real, beta managed-agents-2026-04-01)
whose tools/MCP/skills let it propose experiments; experiments run for real in
Modal sandboxes; the agent reviews results and iterates; the cockpit streams what's
happening, lets the human suggest changes mid-run, and shows the final report+model.

Read first, in this order:
  - docs/GOAL_E2E.md            (this plan — architecture + the loop + slices)
  - apps/api-spec/openapi.yaml  (the contract every tool call conforms to)
  - apps/agent-runtime/         (NEW — the scaffold to flesh out; start at README.md)
  - apps/modal-runner/runner.py (the real executor your launch_experiment calls)
  - docs/data_contract.md, docs/metric_contract.md, docs/rubric.json

Hard rules (unchanged, enforced):
  1. The agent never runs arbitrary training code. It calls the custom tool
     launch_experiment with a manifest; the Modal runner is the only executor. It
     physically strips banned columns from the data server-side before training (so
     post-outcome fields can't reach the model even if a manifest lists them) and
     rejects tune_on=test.
  2. Every run links to a hypothesis and carries rationale + provenance
     (dataset_hash, code_hash, seed). Every critique and decision is recorded.
  3. Compute is gated: launch_experiment requires a recorded approval; without one
     it returns 402 and the runtime surfaces an approval request to the cockpit.
  4. Managed Agents resources: reuse a versioned agent + environment created by a
     bootstrap script — do NOT create-per-study (archive is permanent, no delete).
  5. Use real keys from .env (ANTHROPIC_API_KEY, MODAL_*, CLOUDFLARE_*). Never
     invent credentials; if a key is missing, stop and say which one.

Definition of done is machine-checkable (see the /goal). Outcomes (agent self-eval
rubric) is research-preview — design for it but gate behind MANAGED_AGENTS_OUTCOMES
and fall back to POST /api/grade against docs/rubric.json, which needs no preview.

Prove it with apps/agent-runtime/tests/e2e.smoke.test.* : with a stubbed Anthropic
+ stubbed Modal it must drive create-study → propose → launch → record → critique →
report end to end, asserting the ledger has a baseline run, >=1 corrected rerun, and
a report artifact. Then run the same path once against the REAL APIs for the demo.
```

---

## 3. /goal (paste after the brief)

```
/goal Wire Labmate end to end: a problem+dataset submitted in the cockpit drives a
real Anthropic Managed Agents session whose custom tools run experiments in Modal,
review results, and loop, with the human steering from the cockpit.

Done means ALL of the following are true and verifiable:
  - apps/agent-runtime exists and exposes: POST /agent/start {study_id} and
    GET /agent/{study_id}/stream (SSE). A bootstrap script creates ONE versioned
    agent (model claude-opus-4-8, the DS system prompt, the Labmate custom tools,
    the tabular-ds/leakage/optuna/model-card skills) and ONE cloud environment, and
    writes their IDs to .env (LABMATE_AGENT_ID, LABMATE_ENVIRONMENT_ID).
  - Creating a study via POST /api/studies triggers /agent/start, which calls
    sessions.create(agent, environment), sends the brief+data-contract+rubric as a
    user.message, and streams events.
  - The runtime dispatches the agent's custom tool-use events to real handlers:
    propose_experiments, launch_experiment (REAL POST to the Modal runner),
    query_runs, record_critique, write_report — returning user.custom_tool_result
    each time, and persisting everything to the control plane over the OpenAPI
    contract.
  - launch_experiment enforces the approval gate (402 without one); the runner
    strips banned columns server-side before training and rejects tune_on=test
    manifests (422).
  - The cockpit, on a live study, shows streaming agent activity, a working
    "suggest changes" box that injects a user.message into the session, the run
    table updating as Modal jobs finish, and a final report+model link.
  - The loop self-corrects at least once: the agent (or the leakage/critique tool)
    catches the planted leakage or a test-set-tuning attempt and reruns corrected.
  - apps/agent-runtime/tests/e2e.smoke.test.* passes against stubbed Anthropic+Modal,
    npm run guard is green, and POST /api/grade returns verdict=done for the demo
    study (caught_an_issue check passes).
  - A one-command demo (npm run demo:e2e) runs the whole path on the SEEDED study
    deterministically.
```

---

## 4. Suggested slices (order of build)

**Slice A — agent runtime skeleton + bootstrap (get a session talking).**
Flesh out `apps/agent-runtime`. Implement `bootstrap.mjs`: create the versioned
agent (custom tools declared from the OpenAPI shapes) + the cloud environment,
print/save their IDs. Implement `POST /agent/start` to `sessions.create` and send a
first `user.message`, and `sessions.events.stream()` logging every event. Success:
`node bootstrap.mjs` then starting a session makes the agent respond and call at
least one custom tool you can see on the stream.

**Slice B — custom tool dispatch (give the agent hands).**
Implement the dispatcher: map each custom tool-use to a handler that calls the
control plane / Modal over the contract, then send `user.custom_tool_result`.
Start with `propose_experiments` and `query_runs` (cheap, no compute), then
`launch_experiment` against the **real** Modal runner with the approval gate.
Success: the agent proposes hypotheses and launches one real Modal run that lands
in the ledger with metrics + provenance.

**Slice C — the review loop + done.**
Wire `record_critique`/decision and `write_report`. On each idle/awaiting-input
event, the runtime checks done: if outcomes preview is enabled, read its verdict;
else call `/api/grade`. If not done and budget remains, nudge the agent
("review the latest runs; propose the next experiment or stop"). Seed the leakage/
test-set-tuning catch so the loop self-corrects once. Success: a study runs
baseline → several experiments → a caught issue → corrected rerun → report, and
`/api/grade` returns done.

**Slice D — cockpit live view + steering.**
In `apps/cockpit`: subscribe to `GET /api/studies/{id}/stream` (the control plane
proxies the runtime's SSE) and render the activity timeline into the evidence
ledger pane; make the "suggest changes" box POST feedback that the runtime injects
as a `user.message`; show the report+model link when complete. Success: you can
watch a run live and change its course from the UI.

**Slice E — make it demo-proof.**
`npm run demo:e2e` runs the seeded study deterministically; loading/empty/running
states everywhere; archive nothing by accident; record the self-correction moment.
Success: it runs clean twice in a row.

---

## 5. What to show the judges

1. Type a real problem + drop a CSV in the cockpit. **(Impact + Demo)**
2. The agent spins up, profiles, and proposes experiments — visible live. **(Demo)**
3. A Modal job runs for real; the run appears in the ledger with metrics. **(Demo)**
4. The agent flags the planted leakage / test-set tuning and **reruns corrected**
   — the money moment. **(Demo + Orchestration)**
5. You inject "recall matters more than precision, keep FPR ≤ 20%" from the box and
   the next experiment respects it. **(Opus 4.8 + Demo)**
6. Final report + model card with a reproducible command and provenance. **(Impact)**
7. `npm run guard` green + `/api/grade` → done: "done" verified without a human.
   **(Orchestration)**

The single sentence: *the human gives judgment, a real managed agent does the
science in sandboxes, and every hypothesis, run, critique, and decision is captured
in an agent-native ledger you can steer live.*
```
