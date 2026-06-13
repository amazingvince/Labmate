# Add the E2E (Managed Agents) changes to your existing repo

This overlay adds the end-to-end piece — the Managed Agents runtime, the goal, and
the demo script — to a Labmate repo you've **already** got and modified. It will
not clobber your work: the new files live at new paths, and the script that edits
shared files skips anything already there.

## What's in here

**13 new files** (drop-in, no conflict):
- `apps/agent-runtime/**` — the Managed Agents ↔ Modal/control-plane bridge (10 files)
- `docs/GOAL_E2E.md` — the end-to-end goal + brief + slices
- `scripts/demo_e2e.mjs` — the one-command live demo driver

**4 shared-file edits** (applied by `apply-e2e.mjs`, or by hand below):
- `package.json` — workspace entry + `agent:bootstrap` / `agent:dev` / `test:agent` / `demo:e2e` scripts + `guard` runs `test:agent`
- `.env.example` — the agent-runtime env block
- `scripts/schema-check.mjs` — new paths in the `mustExist` list (only if you use it)
- `apps/api-spec/openapi.yaml` — two routes: `/api/critiques`, `/api/studies/{id}/stream`

---

## Easiest: extract + run the apply script

From your **repo root**:

```bash
# 1. extract this overlay on top of your repo (new files land in place)
unzip labmate-e2e-overlay.zip -d .

# 2. apply the shared-file edits (idempotent — safe to run twice)
node apply-e2e.mjs

# 3. wire it up
npm install            # picks up apps/agent-runtime as a workspace
npm run test:agent     # 4 tests should pass
npm run guard          # full guardrails
```

`apply-e2e.mjs` prints what it changed, what it skipped (already present), and — if
your version of a file has diverged enough that it can't find a safe insertion
point — the exact manual edit to make instead. It never guesses.

> Prefer to keep the helper files out of your tree? After applying, delete
> `apply-e2e.mjs` and this `INSTALL_E2E.md`.

---

## Alternative: do it with git (review as a diff first)

If your working tree is clean and you'd rather review before committing:

```bash
git switch -c feat/e2e-managed-agents
unzip labmate-e2e-overlay.zip -d .
node apply-e2e.mjs
git add -A
git diff --staged        # review every change
git commit -m "Add Managed Agents runtime + E2E goal + demo"
```

`git diff --staged` shows you exactly what landed (new files + the four edits), so
you can eyeball it the same way you would a PR.

---

## Manual changelist (if you'd rather hand-edit, or the script bailed)

### `package.json`
Add the workspace and scripts:
```jsonc
{
  "workspaces": [ /* ...yours... */, "apps/agent-runtime" ],
  "scripts": {
    /* ...yours... */
    "agent:bootstrap": "node apps/agent-runtime/src/bootstrap.mjs",
    "agent:dev": "node apps/agent-runtime/src/server.mjs",
    "test:agent": "node --test apps/agent-runtime/tests/*.test.mjs",
    "demo:e2e": "node scripts/demo_e2e.mjs"
  }
}
```
And append `&& npm run test:agent` to your existing `guard` script.

### `.env.example`
Append:
```
LABMATE_AGENT_ID=
LABMATE_ENVIRONMENT_ID=
AGENT_RUNTIME_PORT=8990
MANAGED_AGENTS_OUTCOMES=false
LABMATE_MAX_TOOL_CALLS=60
LABMATE_MAX_SESSION_SECONDS=1800
```

### `scripts/schema-check.mjs` (only if you have it)
Inside the `mustExist` array, add:
```js
"apps/api-spec/openapi.yaml",
"apps/agent-runtime/src/server.mjs",
"apps/agent-runtime/src/bootstrap.mjs",
"apps/agent-runtime/src/loop.mjs",
"apps/agent-runtime/tests/e2e.smoke.test.mjs",
"docs/GOAL_E2E.md",
"scripts/demo_e2e.mjs",
```

### `apps/api-spec/openapi.yaml`
Add `/api/critiques` and `/api/studies/{studyId}/stream` under `paths:` (above
`components:`). The full YAML for both is what `apply-e2e.mjs` inserts — see the
script, or copy from the deployed spec. Both reference existing components
(`Critique`, `StudyId`, `Unauthorized`) that your spec already defines.

---

## After applying

- `npm run agent:bootstrap` — once, creates the Managed Agent + environment and
  writes `LABMATE_AGENT_ID` / `LABMATE_ENVIRONMENT_ID` to your `.env`.
- `npm run agent:dev` — start the runtime.
- `npm run demo:e2e` — the live end-to-end on the seeded study.
- `docs/GOAL_E2E.md` — paste the brief + `/goal` into Claude Code to build out the
  remaining slices (custom-tool dispatch against real Modal, cockpit live view).

Heads-up unchanged from the build notes: pin/confirm `@anthropic-ai/sdk` and verify
the exact Managed Agents event/tool shapes against the docs before the live demo —
the runtime is written defensively but the beta moves.
