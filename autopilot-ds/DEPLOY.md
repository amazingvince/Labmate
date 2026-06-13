# Deploying Autopilot DS for Build Day

## The one thing that decides the platform
This backend is a **long-running, stateful server**, not a serverless function:
- a background thread keeps a Managed Agents session streaming for minutes,
- the experiment state lives in process memory,
- a thread blocks waiting for the human to resolve a checkpoint,
- the UI polls `/api/state` and every poll must hit the **same process**.

Vercel and Cloudflare **Workers** are stateless-per-request with time limits, so the
naive Flask app doesn't run there — state would vanish between polls and the long run
would time out. The heavy compute (sklearn) runs in **Anthropic's** sandbox, so your
box is a tiny I/O orchestrator, not a compute server.

## Recommendation (ranked)

**1. Easiest, fits the code as-is (~15 min) — a persistent web service.**
Render, Railway, or Fly run a long-lived process with a public URL. One deploy serves
both the API and the frontend. **Do this for the hackathon.**

**2. Want the Vercel/Cloudflare brand on the URL — split it.**
Static frontend on Cloudflare Pages or Vercel; backend on Render (option 1). The app
already has CORS enabled, so cross-origin polling works with zero changes. Two
deploys, still the code as-is.

**3. Full serverless (more work — only with time to spare).**
- **Vercel:** rebuild the driver as a *Vercel Workflow* (durable `defineHook`/`sleep`
  polling the MA events API, streaming to the client) + external state.
- **Cloudflare:** *Durable Object* for state + MA *webhooks* (or polling) instead of
  the streaming thread; frontend on Pages.
Both are real rearchitectures. Don't start this at 2 PM.

> If you're set on Cloudflare specifically: **Cloudflare Containers** can run this
> image (option 1's Dockerfile) without the rearchitect — but it's more setup than
> Render. Workers cannot run it.

## Deploy it (option 1, Render via Docker — works the same on Railway/Fly)

The repo already has a verified `Dockerfile` and `Procfile`. The required start
command (proven working) is **one worker, threaded**:
```
gunicorn -w 1 --threads 8 --max-requests 0 --timeout 0 --chdir backend app:app
```

**Render (Docker):**
1. Push the repo to GitHub (it must be public for submission anyway).
2. Render → New → **Web Service** → connect the repo.
3. Render detects the `Dockerfile`. Instance type: the smallest is fine.
4. **Environment → add `ANTHROPIC_API_KEY`** = your Build Day credit key. (Never commit
   it — the repo is public.)
5. Deploy. You get `https://<name>.onrender.com`. That's your URL.

**Render (no Docker):** set Root Directory `backend`, Build `pip install -r
requirements.txt`, Start `gunicorn -w 1 --threads 8 --max-requests 0 --timeout 0
app:app`, add the env var. (The `Procfile` encodes this too.)

**Railway:** New Project → Deploy from repo → it reads the `Procfile`/`Dockerfile` →
add `ANTHROPIC_API_KEY` in Variables → Generate Domain.

**Fly:** `fly launch` (detects the Dockerfile) → `fly secrets set ANTHROPIC_API_KEY=…`
→ `fly deploy`.

## Critical gotchas
- **ONE worker.** `-w 1`. With 2+ workers each gets its own memory; a run started in
  one worker is invisible to polls routed to another, and the checkpoint never shows.
  Use `--threads` for concurrency, never `-w >1`. (This was verified: `-w 1 --threads
  8` passes the full conformance test; it's the whole reason this isn't on Workers.)
- **No worker recycling / no request timeout.** `--max-requests 0 --timeout 0` so a
  long run isn't killed mid-flight. A single run is minutes; the default 30s timeout
  would kill it.
- **Secret, not committed.** Public repo + API key in code = leaked key + possible DQ.
  Set `ANTHROPIC_API_KEY` in the host's env only.
- **Free-tier sleep.** Render free services sleep when idle and cold-start ~30–60s.
  Hit the URL right before you demo, or use a paid instance for demo day.

## Smoke test the live URL (this is also your Orchestration score)
The Orchestration criterion rewards a "done" the model can verify without a human — a
responding URL + a test it grades against. You already have both:
```
python tests/test_contract_e2e.py https://<your-name>.onrender.com
```
Green = the deployed agent runs a real experiment loop, catches the leak, takes the
approval, and finishes honestly — proven by an external test, not a claim. Put that
command (and its PASS) in your brief.

## Conserve credits during setup
$500, 24h. Each real run uses Opus 4.8 + a sandbox (a few dollars). **Develop and
rehearse the UI against `mock_backend.py`** (no key, no cost) and only point at the
real backend for integration rehearsals and the live demo. The mock emits the same
contract, so anything that looks right on it is right.

## Demo-day risk mitigation (3-min stage demo)
- A live run is 1–3 min — too slow to start cold on stage. **Pre-warm**: start a run a
  minute before you present so the leaderboard is already filling and the checkpoint is
  near.
- **Record a clean run** as a fallback in case the API hiccups live; the 1-min
  submission video should be a recorded clean run anyway.
- The money shot is the **leakage checkpoint**: narrate "the agent reviewed its own
  0.99 model, caught the leak, and is asking me to approve dropping it" → click
  Approve → honest 0.84 lands. That is exactly the "moment it caught and fixed a
  failure" the judges ask you to show.

## Submission checklist
- [ ] Repo public on GitHub; all demoed code in it (it's standalone).
- [ ] Live URL responds; `test_contract_e2e.py` passes against it.
- [ ] Brief includes: the problem, the `/goal` prompts, the rubric files, and the live
      smoke-test command + PASS.
- [ ] 1-min video = a recorded clean run showing the leakage catch + approval.
- [ ] `ANTHROPIC_API_KEY` is in host env only, never in the repo.
