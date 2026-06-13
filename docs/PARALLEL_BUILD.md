# Parallel build plan — front end and back end at the same time

The whole point of the OpenAPI spec (`apps/api-spec/openapi.yaml`) is that it
lets two tracks move independently. The **contract is the integration point**:
the back end implements it; the front end builds against a mock generated from
it. You only "integrate" by pointing the cockpit at the real Worker instead of
the mock — and if both sides honored the spec, it just works.

This plan gives you (1) a git worktree layout so two Claude Code sessions never
collide, (2) the exact kickoff prompt and `/goal` for each track, and (3) the
rule that keeps them in sync.

---

## The one rule

> **The spec is the source of truth. Code changes to satisfy the spec; the spec
> does not drift to match code.** If either track needs the contract changed,
> they edit `apps/api-spec/openapi.yaml` on a short-lived `spec/*` branch, both
> tracks pull it, then continue. Never let the FE invent a field the spec
> doesn't have, and never let the BE return a shape the spec doesn't describe.

`npm run spec:lint` (added below) fails CI if the spec is malformed, and the
back-end track has a contract test that fails if a response violates the spec.

---

## 1. Git worktrees

Worktrees let one clone have multiple working directories on different branches
at once — perfect for running two Claude Code sessions side by side without
branch-switching churn or merge stomping.

From the repo root (on `main`), create a shared integration branch and two track
branches, each in its own directory:

```bash
# integration branch both tracks merge into
git switch -c integration
git push -u origin integration

# back-end worktree on its own branch
git worktree add ../labmate-backend -b track/backend integration

# front-end worktree on its own branch
git worktree add ../labmate-frontend -b track/frontend integration
```

You now have three directories sharing one git history:

```
labmate/            (main / integration — specs, docs, shared packages)
labmate-backend/    (track/backend  — apps/web, apps/modal-runner, apps/mcp-server)
labmate-frontend/   (track/frontend — apps/web/cockpit or apps/cockpit)
```

Open a **separate Claude Code session in each track directory**. Each gets its
own context, its own `/goal`, and edits its own files. They share the spec via
git, not by editing the same files.

### Who owns what (avoid write conflicts)

| Path | Owner | Notes |
|---|---|---|
| `apps/api-spec/openapi.yaml` | **shared** | change only via a `spec/*` branch both pull |
| `apps/web/src/worker.js` | back end | the control-plane routes |
| `apps/web/schema.sql` | back end | D1 tables |
| `apps/modal-runner/**` | back end | the fixed runner |
| `apps/mcp-server/**` | back end | thin wrappers over the Worker routes |
| `packages/schemas/**` | **shared** | change with the spec, in lockstep |
| `apps/cockpit/**` (new) | front end | the SPA; talks to the spec, mock first |
| `docs/**`, `.claude/**` | shared | coordinate; mostly stable during the build |

The front end builds in a **new `apps/cockpit/` directory** rather than editing
the Worker's inline `COCKPIT_HTML`, so the two tracks touch disjoint files. The
Worker keeps serving a placeholder until you wire the built SPA at the end.

### Merging

Both tracks merge into `integration` frequently (small, often). Because they
edit disjoint paths, merges are clean. Final `integration -> main` once the
cockpit points at the real Worker and `npm run guard` is green.

```bash
# from a track dir, when a slice is done:
git add -A && git commit -m "track: <slice>"
git switch integration && git merge --no-ff track/backend && git push
git switch track/backend   # back to work
```

---

## 2. Generate the mock + types from the spec (do this once, up front)

This is what unblocks the front end immediately.

```bash
# Mock server: serves spec-accurate fake responses on :4010
npx @stoplight/prism-cli mock apps/api-spec/openapi.yaml --port 4010

# TypeScript types for both tracks, generated from the spec
npx openapi-typescript apps/api-spec/openapi.yaml -o packages/api-types/index.ts
```

Add these to `package.json` so they're one command (the back-end track owns the
edit, but both use them):

```jsonc
"scripts": {
  "spec:lint": "npx @redocly/cli lint apps/api-spec/openapi.yaml",
  "spec:mock": "npx @stoplight/prism-cli mock apps/api-spec/openapi.yaml --port 4010",
  "spec:types": "npx openapi-typescript apps/api-spec/openapi.yaml -o packages/api-types/index.ts",
  "spec:docs": "npx @redocly/cli build-docs apps/api-spec/openapi.yaml -o apps/api-spec/index.html"
}
```

The front end sets `VITE_API_BASE=http://localhost:4010` and builds the entire
cockpit against the mock. The back end runs `wrangler dev` on :8787 and makes the
real routes match the same spec. Flip `VITE_API_BASE` to the wrangler URL to
integrate.

---

## 3. Back-end track — kickoff + goal

Open Claude Code in `../labmate-backend`. Paste this brief, then the `/goal`.

### Brief (paste first)

```
You are the BACK-END track for Labmate, an agent-native data science harness.
Your contract is apps/api-spec/openapi.yaml — implement the Cloudflare Worker so
every route matches it exactly. Read these first:
  - apps/api-spec/openapi.yaml   (the contract you must satisfy)
  - apps/web/schema.sql          (D1 tables for the evidence ledger)
  - packages/schemas/*.schema.json (entity shapes; keep in lockstep with the spec)
  - CLAUDE.md                    (hard rules, conventions, provenance)

Scope (your files only): apps/web (Worker routes, D1, Durable Object, R2),
apps/modal-runner (the fixed runner), apps/mcp-server (thin wrappers over your
routes). Do NOT touch apps/cockpit — that's the front-end track.

Rules of engagement:
  1. The spec is the source of truth. If a route needs a shape the spec lacks,
     STOP, propose an edit to apps/api-spec/openapi.yaml, and note it — do not
     silently diverge.
  2. Every run links to a hypothesis and carries rationale; every critique and
     decision is recorded. Provenance (dataset_hash, code_hash, seed) on every
     report artifact.
  3. Compute launches require a recorded approval; reject launch_experiment with
     402 if none exists or budget is exceeded. Reject manifests with banned
     columns in features, or tune_on=test, with 422.
  4. Tuning happens on validation only. The runner is fixed — no arbitrary code.

Write a contract test (tests/contract.api.test.mjs) that boots the Worker with
`wrangler dev`, hits each route with the spec's example bodies, and asserts the
responses validate against the spec's response schemas. That test is your
definition of done for the API surface.
```

### Goal (paste after)

```
/goal Implement the Labmate control plane so it satisfies apps/api-spec/openapi.yaml.
Done means: apps/web/schema.sql creates tables for study, dataset_version,
hypothesis, run, critique, decision, feedback, artifact; every route in the spec
is implemented against D1/R2 with bearer-token auth on writes; launch_experiment
verifies an approval, submits the manifest to the Modal runner, and records a run
with metrics/params/artifacts and provenance; query_runs supports metric, model
family, hypothesis, tags, and critique-kind filters; write_report stores a model
card in R2 and records a kind=report artifact; grade returns pass/fail per rubric
check from docs/rubric.json; and `tests/contract.api.test.mjs` passes against a
running `wrangler dev`, with `npm run guard` green.
```

### Suggested back-end slices (let Claude sequence them)

1. `schema.sql` + D1 migration; `GET /api/studies/{id}` returning the empty
   ledger shape from the spec. (Unblocks the FE's real-data path early.)
2. `POST /api/studies`, `/api/profile`, `/api/experiments/propose`.
3. `/api/approvals/request` + `/api/feedback` (incl. the approval gate).
4. `/api/experiments/launch` -> Modal runner -> record run + provenance.
5. `/api/runs/query` filters; `/api/reports` -> R2; `/api/grade` vs rubric.
6. Durable Object event stream (nice-to-have for live cockpit updates).

---

## 4. Front-end track — kickoff + goal

Open Claude Code in `../labmate-frontend`. Paste this brief, then the `/goal`.

### Brief (paste first)

```
You are the FRONT-END track for Labmate, an agent-native data science harness.
You build the mission-control cockpit in a NEW directory apps/cockpit (do not
edit apps/web — that's the back-end track). Your contract is
apps/api-spec/openapi.yaml; build entirely against the Prism mock at
http://localhost:4010 using the generated types in packages/api-types.

Read first:
  - apps/api-spec/openapi.yaml   (every shape you render comes from here)
  - docs/BRIEF.md (section 9, the cockpit)  and docs/DEMO_SCRIPT.md
  - packages/api-types/index.ts  (generated TS types — import these, do not hand-write shapes)

The cockpit is a four-pane mission control, NOT a dashboard:
  1. Brief + rubric — objective, metric, guardrails, budget, "done" criteria.
  2. Experiment cards — per hypothesis: statement, expected impact, cost,
     status, latest metric, agent rationale, and approve / deny / rerun buttons.
  3. Evidence ledger — timeline of runs, notes, critiques, human feedback.
  4. Current recommendation — e.g. "Promote model 7 after a calibration check."
Plus a natural-language feedback box that POSTs to /api/feedback, and a
"Generate report" button that POSTs to /api/reports and links the artifact.

Rules of engagement:
  1. The spec is the source of truth. If you need a field it lacks, STOP and
     propose a spec edit — do not invent response shapes or hardcode mock data
     beyond what the spec describes.
  2. Read everything from GET /api/studies and GET /api/studies/{id}. All writes
     go to the documented POST routes with the bearer token from an env var.
  3. Make it resilient: loading and empty states for every pane, optimistic UI
     on approve/deny, and graceful handling of a run still "running".
  4. Use VITE_API_BASE so flipping from the mock (:4010) to the real Worker
     (:8787 / the deployed URL) is a one-line change.
```

### Goal (paste after)

```
/goal Build the Labmate cockpit in apps/cockpit against the Prism mock at
VITE_API_BASE. Done means: a study-list view (GET /api/studies) and a study
detail view rendering all four panes from GET /api/studies/{studyId}; experiment
cards with working approve/deny/rerun that POST to /api/feedback and
/api/approvals/request; a natural-language feedback box; a run table fed by the
study detail's runs with status, metrics, and linked critiques; a "Generate
report" button hitting /api/reports that surfaces the artifact link; every pane
has loading and empty states; the app imports types from packages/api-types and
builds with `npm run build` clean; and switching VITE_API_BASE to the wrangler
URL renders real data with no code change.
```

### Suggested front-end slices

1. Vite + TS app skeleton in `apps/cockpit`; API client wrapper around
   `VITE_API_BASE` that injects the bearer token; import `packages/api-types`.
2. Study-list + study-detail shell with the four empty panes (loading/empty
   states first — they're most of the resilience).
3. Experiment cards from `hypotheses` + latest run metric; approve/deny/rerun.
4. Evidence ledger timeline merging runs + critiques + feedback by time.
5. Feedback box -> `/api/feedback`; recommendation pane; report button.
6. Polish pass: optimistic updates, "running" spinners, error toasts.

---

## 5. Integration (the easy part, if you held the contract)

```bash
# 1. Back end is deployed or running:  wrangler dev  (:8787)
# 2. Point the cockpit at it:
echo "VITE_API_BASE=http://127.0.0.1:8787" > apps/cockpit/.env.local
# 3. Run the back end's contract test against the same URL:
npm run --workspace=apps/web test:contract
# 4. Click through the demo in docs/DEMO_SCRIPT.md end to end.
```

If a pane renders wrong, the response didn't match the spec → fix the **back
end** (or, if the spec was wrong, fix the spec and regenerate types). The FE
should not be patched to accommodate an off-spec response.

Finally, build the cockpit and have the Worker serve it (replace the inline
`COCKPIT_HTML` with the built `apps/cockpit/dist`), then merge `integration` to
`main`, deploy, and confirm `LABMATE_PUBLIC_URL` serves the real cockpit.

---

## 6. Driving both with one orchestration story (for judging)

The Orchestration criterion rewards a setup another team could rerun. Yours is:

- **One contract** (`openapi.yaml`) both tracks build against.
- **Two `/goal`s**, each with a machine-checkable done: the BE's
  `contract.api.test.mjs` and the FE's `npm run build` + mock-to-real swap.
- **`npm run guard`** (schema-check + lint + tests) plus **`npm run spec:lint`**
  gate every merge in CI.
- The **self-correction moment** still lives in the back-end + workflow track
  (the critic catching the planted leakage / test-set tuning).

Show the judges: the spec, the two goals, the two green "done" signals, and the
moment a track caught a contract mismatch (or the agent caught the leakage) and
fixed it without you.

---

## Quick reference

```bash
# worktrees
git worktree add ../labmate-backend  -b track/backend  integration
git worktree add ../labmate-frontend -b track/frontend integration
git worktree list
git worktree remove ../labmate-frontend   # when done

# spec tooling
npm run spec:lint     # validate the contract
npm run spec:mock     # mock server on :4010 (front end builds against this)
npm run spec:types    # regenerate packages/api-types from the spec
npm run spec:docs     # human-readable API docs

# keep in sync
git switch integration && git pull        # both tracks, often
```
