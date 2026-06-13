# Running the two streams in parallel in Claude Code

This wires the backend and UI backlogs into **two `/goal` runs that close on
machine-checkable criteria**, isolated in git worktrees, each hard-gated by a `Stop`
hook so neither can declare itself done while its automated checks fail.

The pieces:
- **Goals** (below) — one `/goal` per stream; their completion criteria are anchored
  to a script's exit code, so the goal loop can actually verify "done".
- **Rubrics** — [`rubrics/RUBRIC_backend.md`](rubrics/RUBRIC_backend.md),
  [`rubrics/RUBRIC_ui.md`](rubrics/RUBRIC_ui.md). Gating rows = must pass.
- **Gates** — `scripts/gate.sh <stream>` runs the fast automated checks and exits 2
  (keep going) or 0 (may stop). Wired as each worktree's `Stop` hook.
- **The conformance test** — `tests/test_contract_e2e.py` proves the backend's live
  behavior and is the integration gate. It already passes against `mock_backend.py`.

> Why anchor goals to exit codes: a `/goal` loop only terminates when its success
> criteria are *verifiable*. "Build the UI" never closes; "`scripts/gate.sh ui` exits
> 0 and I've confirmed each gating visual row against the mock" does. The `Stop` hook
> is the belt to that suspenders — a deterministic block so the agent can't stop on a
> red gate even if it convinces itself the work is done.

---

## 0. Freeze the contract
Both goals forbid editing `API_CONTRACT.md`. Agree it first; after that it changes
only by mutual edit there, and both streams re-pull.

## 1. Create one worktree per stream
Worktrees give each Claude Code session an isolated checkout + branch, so the two
agents never touch the same files or git state. From the repo root:

```bash
git switch -c main 2>/dev/null || true          # ensure you have a base branch
git worktree add ../autopilot-backend -b stream/backend
git worktree add ../autopilot-ui      -b stream/ui
```

You now have `../autopilot-backend` and `../autopilot-ui`, each a full checkout
(both contain `scripts/`, `tests/`, the rubrics, and the scaffold). Open a **separate
Claude Code session in each directory**.

> The two streams touch disjoint directories (`backend/` vs `frontend/`), so a lighter
> setup — two sessions in one checkout with disciplined commits — also works. Worktrees
> are the clean default and let you merge two branches at integration.

## 2. Add the Stop-hook gate to each worktree
Drop this in **`../autopilot-backend/.claude/settings.json`**:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bash scripts/gate.sh backend" } ] }
    ]
  }
}
```

And **`../autopilot-ui/.claude/settings.json`**:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bash scripts/gate.sh ui" } ] }
    ]
  }
}
```

Now, when the agent tries to end its turn, the gate runs; a failing gate exits 2,
which blocks the stop and feeds the reason back so the agent keeps working until the
automated criteria are green. (Confirm the exact `Stop` hook schema against the Claude
Code hooks docs if your version differs; the gate script itself is version-agnostic.)

## 3. Kick off each goal
In the **backend** session:

```
/goal Implement the backend stream so the API contract is satisfied by a real
Managed Agents integration.

Source of truth, read first: API_CONTRACT.md (the frozen interface — DO NOT edit it),
BACKLOG_backend.md (tickets, in order), rubrics/RUBRIC_backend.md (how you're graded).

Scope: work only inside backend/ and tests/. Do not touch frontend/ or
API_CONTRACT.md. Implement BE-0..BE-8 in order. For each Managed Agents call, verify
field names against the docs (the # [MA] tags) and record any you change in MA_NOTES.md.

You are DONE only when ALL of these hold:
  1. `bash scripts/gate.sh backend` exits 0.
  2. With ANTHROPIC_API_KEY set and the backend running locally,
     `python tests/test_contract_e2e.py http://localhost:8000` exits 0
     (full conformance: live run, experiments, the leakage checkpoint,
     approve -> honest best > 0.71, steer, stop).
  3. Every gating row in rubrics/RUBRIC_backend.md is satisfied.

Do not claim completion until both the gate and the e2e test pass. If you believe the
contract itself must change, STOP and ask me — do not edit it.
```

In the **UI** session:

```
/goal Implement the UI stream so the API contract is satisfied, verified against the
mock backend.

Source of truth, read first: API_CONTRACT.md (the frozen interface — DO NOT edit it),
BACKLOG_ui.md (tickets, in order), rubrics/RUBRIC_ui.md (how you're graded).

Scope: work only inside frontend/. Do not touch backend/ or API_CONTRACT.md. Build and
verify against the mock: run `python mock_backend.py` and open http://localhost:8000.

You are DONE only when ALL of these hold:
  1. `bash scripts/gate.sh ui` exits 0.
  2. Against the running mock you have clicked through Start -> steer -> the checkpoint
     -> approve -> done, plus the error state (MOCK_FORCE_ERROR=1) and the stopped state,
     and every gating row of rubrics/RUBRIC_ui.md renders correctly. Confirm each gating
     row with a one-line note in your final message.
  3. The UI renders only from /api/state and uses only the five contract endpoints.

The visual criteria need your eyes — actually load the mock and drive it; don't infer
behavior from the contract. Do not edit the contract; if it must change, STOP and ask.
```

## 4. While they run
Each agent loops against its goal; the Stop hook keeps it honest. You can let them run
and check in, steering either session as needed. The backend agent will need
`ANTHROPIC_API_KEY` to run the e2e test (criterion 2); until then it works the gate
(criterion 1) and the tickets.

## 5. Integration (the streams meet)
When both goals report done:

```bash
# from the repo root
git merge stream/backend          # backend/ + tests/ + MA_NOTES.md
git merge stream/ui               # frontend/  (disjoint paths -> clean merge)
```

Then run the **Definition of Done** (API_CONTRACT.md §4) with the real UI in front of
the real backend:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
python backend/app.py &           # real agent
# open http://localhost:8000 and walk: Start -> watch experiments -> steer ->
# the leakage checkpoint -> Approve -> honest best -> done -> Stop
python tests/test_contract_e2e.py http://localhost:8000   # automated DoD, against the real backend
```

Green test + the visual walk = demo ready. Clean up worktrees when done:
`git worktree remove ../autopilot-backend && git worktree remove ../autopilot-ui`.

---

## Notes & options
- **Optional contract lock:** to make "don't edit the contract" enforced rather than
  asked, add a `PreToolUse` hook on `Edit`/`Write` that denies edits to
  `API_CONTRACT.md`. The goal constraint usually suffices for a hackathon.
- **`/batch` instead of two sessions:** if your Claude Code supports it, `/batch` fans
  parallel agents across isolated worktrees in one go — same gate/rubric wiring, less
  manual session juggling.
- **Agent teams** are the heavier alternative (an orchestrator delegating to the two
  streams). For two well-isolated streams against a frozen contract, two worktrees +
  two goals is the simpler, more reliable pattern.
- **The mock is the shared clock:** the UI gate and the UI goal both lean on
  `mock_backend.py`, which emits the same contract the real backend will — so UI work
  validated against the mock holds against the real thing at integration.
