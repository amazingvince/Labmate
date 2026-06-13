# Environment & keys

Copy `.env.example` → `.env` and fill these in. `./scripts/preflight.sh` validates them.

## Anthropic
- **ANTHROPIC_API_KEY** — from https://console.anthropic.com/settings/keys. At Build Day
  you'll get a $500 credits link (24h expiry) handed out on the day; redeem it and use that
  key. Ask in `#credit-questions` on Discord if you don't have it.
- **ANTHROPIC_MODEL** — leave as `claude-opus-4-8`. Judges weight creative Opus 4.8 use, so
  keep the headline reasoning calls (planning, leakage review, critique, feedback parsing)
  on Opus.

## Modal (experiment execution)
1. Create an account at https://modal.com.
2. `pip install modal` then `modal token new` — this writes `~/.modal.toml` and prints a
   token id + secret. Put them in **MODAL_TOKEN_ID** / **MODAL_TOKEN_SECRET**.
3. Deploy the runner: `modal deploy apps/modal-runner/runner.py`. Modal prints a web URL
   for the FastAPI endpoint — paste it into **MODAL_RUNNER_URL**.

## Cloudflare (cockpit + control plane)
1. **CLOUDFLARE_ACCOUNT_ID** — dash.cloudflare.com, right sidebar.
2. **CLOUDFLARE_API_TOKEN** — create a token with edit perms for Workers, D1, R2, and
   Durable Objects.
3. `npx wrangler d1 create labmate` → paste the printed `database_id` into
   **CLOUDFLARE_D1_DATABASE_ID** (and into `apps/web/wrangler.toml`).
4. `npx wrangler r2 bucket create labmate-artifacts` → **CLOUDFLARE_R2_BUCKET**.
5. After `npx wrangler deploy`, your Worker URL becomes **LABMATE_PUBLIC_URL** (your
   submission's live URL).

## MCP server (local)
- **MCP_SERVER_PORT** — default `8787`.
- **LABMATE_INTERNAL_TOKEN** — shared secret between MCP server and Worker. Generate with
  `openssl rand -hex 24`.

## Optional guardrails
- **LABMATE_DEFAULT_MAX_TRIALS** (default 20) and **LABMATE_DEFAULT_BUDGET_SECONDS**
  (default 600) cap Optuna/compute unless the human raises them in the cockpit.

## Security notes
- `.env` is gitignored — never commit it. The repo must be public for judging, so keep all
  secrets out of it.
- The Modal runner has no arbitrary network egress; the MCP server talks to Cloudflare with
  `LABMATE_INTERNAL_TOKEN`, not your Cloudflare API token.
