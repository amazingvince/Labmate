# Deploying Labmate

This is the runbook for taking Labmate live. One command ships the Cloudflare control
plane (cockpit + API + dataset); two `modal deploy`s ship the compute. A read-only
verifier tells you whether the new code is actually live.

## What each component is

| Component | Where | What it does | How it ships |
| --- | --- | --- | --- |
| **Worker** (`labmate`) | `apps/web` | Serves the cockpit SPA **and** the `/api` control plane on `amazingvince.com/*` (apex zone route) + `labmate.amazingvince.com` (custom domain). Bindings: D1 `labmate` (`DB`), R2 `labmate-artifacts` (`ARTIFACTS`), Durable Object `STUDY`. | `wrangler deploy` (via `scripts/deploy.sh`) |
| **Cockpit SPA** | `apps/cockpit` | React UI; built to `dist/`, served by the Worker as Static Assets. Calls `/api` **same-origin**. | `npm run build` (inside `deploy.sh`) |
| **Dataset** | R2 `datasets/sla_tickets.csv` | Served at `/data/sla_tickets.csv`; the runner + cockpit fetch the study CSV from here. **`wrangler deploy` does not upload it** — `deploy.sh` does (the reproducibility step). | `wrangler r2 object put` (inside `deploy.sh`) |
| **Modal runner** (`labmate-runner`) | `apps/modal-runner/runner.py` | Sandboxed training jobs. Worker var `MODAL_RUNNER_URL` points at it. | `modal deploy` (manual) |
| **Agent runtime** (`labmate-agent-runtime`) | `apps/agent-runtime/modal_app.py` | Managed-agent platform that drives the autonomous study loop; the Worker proxies its SSE. Worker var `AGENT_RUNTIME_URL` points at it. | `modal deploy` (manual) |

The real topology lives in `apps/web/wrangler.toml` — treat that as the source of truth.

## Prerequisites

- **Node 18+** and **npx** (wrangler runs via `npx`; the repo pins `wrangler` in
  `apps/web/package.json`).
- A **Cloudflare login** for wrangler: `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`
  with Workers/D1/R2 scopes). The account, D1 database id, and R2 bucket in
  `wrangler.toml` must already exist.
- **openssl** (to generate the write token, if you don't supply one).
- For the compute (manual steps): **Modal** (`pip install modal` + `modal token new`)
  and an **Anthropic API key**.
- Run `./scripts/preflight.sh` first — it checks tooling and `.env` keys.

## The write token (`LABMATE_INTERNAL_TOKEN`)

Reads are public; **writes** (`POST /api/*`) require this server-side secret. The Worker
**refuses writes** (503 `writes_disabled`) when the token is missing or shorter than
**24 chars**, so it must be `>= 24` chars. Generate one with:

```bash
openssl rand -hex 24    # 48 hex chars — safely above the 24-char floor
```

`deploy.sh` will generate and `export` one for you if `LABMATE_INTERNAL_TOKEN` is unset,
**print it once**, and set it as the Worker secret. Save that value — it is not printed
again and you need it to drive writes or a writeable demo.

- **Read-only public deploy (default):** the cockpit ships with a blank `VITE_API_TOKEN`,
  so no write token reaches the browser. The site is viewable; writes are rejected.
- **Writeable/interactive demo:** export `VITE_API_TOKEN=<the same token>` before running
  `deploy.sh` so the SPA can authenticate writes. That token then ships in the JS bundle
  (public), so only use a token you are comfortable exposing, and keep it equal to the
  Worker secret.

## One command

```bash
./scripts/deploy.sh
```

It runs, fail-fast and idempotent:

1. **Preflight** — checks `node`/`npx`/wrangler; ensures a `>= 24`-char
   `LABMATE_INTERNAL_TOKEN` (generates one if unset); warns (does not fail) if
   `ANTHROPIC_API_KEY` / `MODAL_*` are unset (those are for the Modal apps).
2. **Build the cockpit** — `npm ci && npm run build` in `apps/cockpit` with
   `VITE_API_BASE=` (same-origin) and `VITE_API_TOKEN=` (blank → read-only).
3. **Apply the D1 schema** — `wrangler d1 execute labmate --file=schema.sql --remote`.
4. **Seed the dataset into R2** — `wrangler r2 object put labmate-artifacts/datasets/sla_tickets.csv`
   from `examples/sla_tickets/data.csv`, then verifies it.
5. **Set the write secret** — pipes the token to `wrangler secret put LABMATE_INTERNAL_TOKEN`.
6. **Deploy the Worker** — `wrangler deploy` (binds both hostnames + all bindings).
7. **Prints the manual Modal steps** (it does not run them).
8. **Runs `scripts/verify_live.sh`** against the deployed site.

Useful flags / env:

```bash
./scripts/deploy.sh --dry-run                 # print every command, run nothing
VERIFY_TARGET=https://amazingvince.com ./scripts/deploy.sh   # verify the apex host instead
VITE_API_TOKEN=<token> ./scripts/deploy.sh    # bake a write token for an interactive demo
```

## Manual: deploy the compute (Modal) and wire the vars

`deploy.sh` deliberately skips these — they need the `modal` CLI and live tokens.

```bash
pip install modal
modal token new                                   # one-time auth

# 1) the sandboxed experiment runner
modal deploy apps/modal-runner/runner.py          # app: labmate-runner

# 2) the managed agent runtime (drives the autonomous loop)
modal deploy apps/agent-runtime/modal_app.py      # app: labmate-agent-runtime
```

Then confirm the Worker vars point at the deployed Modal URLs (in
`apps/web/wrangler.toml [vars]`):

- `MODAL_RUNNER_URL`  → the `labmate-runner` launch endpoint
- `AGENT_RUNTIME_URL` → the `labmate-agent-runtime` endpoint

If either changed, edit `wrangler.toml` and re-run `./scripts/deploy.sh` (or
`cd apps/web && npx wrangler deploy`).

## Secrets to rotate (and why)

| Secret | Used by | Why rotate |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | agent-runtime (Modal) | Drives planning, leakage critique, and NL→constraint parsing. Rotate on the Modal side (`modal secret`), never in git. |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Modal CLI/auth | Authenticates `modal deploy` and job launches. |
| `LABMATE_INTERNAL_TOKEN` | Worker (`secret put`) + cockpit (`VITE_API_TOKEN`, only for a writeable demo) | Gates all writes. If you rotate it, re-run `deploy.sh` so the Worker secret and (optionally) the cockpit bundle match — otherwise writes 401. |

Never commit any of these. `.gitleaks.toml` + the pre-commit hook guard against it.

## Verify

```bash
./scripts/verify_live.sh https://labmate.amazingvince.com
```

Read-only smoke test (the one write it makes is a tokenless POST it asserts is
**rejected**). It checks `/api/studies`, `/data/sla_tickets.csv` (R2 seeded), a study's
detail/report/grade/stream routes, and the unauthenticated-write rejection. It prints a
PASS/FAIL table and an explicit **`NEW CODE LIVE? yes/no`** line, driven by the
`/api/studies/{id}/grade` check — a **new route** absent from the old deploy. A `404`
there is the old router's misleading `not_found`, meaning the new code is not live yet.
The script exits non-zero if any check fails.

## Rollback

Cloudflare keeps prior Worker versions:

```bash
cd apps/web
npx wrangler deployments list          # find a known-good version id
npx wrangler rollback [<version-id>]   # roll the Worker back
```

Or redeploy a previous build by checking out the earlier commit and re-running
`./scripts/deploy.sh`. D1 and R2 are **not** reverted by a Worker rollback — the schema
is additive and the dataset object is stable, so a code rollback is safe on its own. To
roll back the Modal apps, `modal deploy` the previous revision of the two app files.
