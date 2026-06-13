# Getting started — the runbook

Do these in order. Steps 0–2 cost **no** credits and prove your toolchain works; step
3 spends a little to de-risk the live API; step 4 is the parallel build.

---

## 0 · Put the files in a public repo
Unzip the starter into a new folder, then:
```bash
git init
git add .
git commit -m "Autopilot DS starter"
# create an EMPTY public repo on GitHub, then:
git remote add origin https://github.com/<you>/autopilot-ds.git
git branch -M main
git push -u origin main
```
The repo must be public for submission. The API key is **never** committed (see step 1).

## 1 · One-time local setup
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # your Build Day credit key — env only, not in code
```

## 2 · Prove it works locally (no credits) and see the target
```bash
# the gates pass on the starter — this confirms your toolchain is wired right
bash scripts/gate.sh backend
bash scripts/gate.sh ui

# run the MOCK and watch the whole scripted run, including the leakage checkpoint
python mock_backend.py        # then open http://localhost:8000 and click "Start"

# in another shell: the full conformance test passes against the mock
python tests/test_contract_e2e.py http://localhost:8000
```
This is also how the UI stream develops all day — against the mock, for free. The mock
emits the same contract as the real backend, so anything that looks right on it is right.

## 3 · De-risk the live Managed Agents calls (small credit spend)
The only real unknowns are the `# [MA]`-tagged field names in `backend/app.py` (beta
API). Smoke-test one real session before fanning out:
```bash
python backend/app.py          # the REAL agent; open http://localhost:8000, click Start
```
Watch the activity feed. If a `# [MA]` field name is wrong, it surfaces as
`status: error` with the exception — fix that one spot in `backend/app.py`
(`agents.create` params, the custom-tool wrapper, the event names) and re-run. Once a
run reaches a checkpoint and finishes, the names are right. (The backend `/goal` in
step 4 will also drive this — this is just to retire the risk early.)

## 4 · Kick off the two streams in parallel (Claude Code)
Isolate each stream in its own worktree so two sessions never collide:
```bash
git worktree add ../autopilot-backend -b stream/backend
git worktree add ../autopilot-ui      -b stream/ui
```

Add the Stop-hook gate to each worktree so neither session can "finish" on a red gate:
```bash
# backend worktree
mkdir -p ../autopilot-backend/.claude
cat > ../autopilot-backend/.claude/settings.json <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "bash scripts/gate.sh backend" } ] } ] } }
EOF

# ui worktree
mkdir -p ../autopilot-ui/.claude
cat > ../autopilot-ui/.claude/settings.json <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "bash scripts/gate.sh ui" } ] } ] } }
EOF
```
(Confirm the exact Stop-hook schema against your Claude Code version if it differs; the
gate script is version-agnostic.)

**In your Claude Code sessions** — open one per worktree and paste its goal:
```bash
cd ../autopilot-backend && claude     # then paste the BACKEND /goal below
cd ../autopilot-ui      && claude     # then paste the UI /goal below
```
The two `/goal` prompts are in `PARALLEL_BUILD.md` §3 — copy them verbatim. They point
each session at the contract + its backlog + its rubric, scope it to its directory, and
make "done" mean the gate exits 0 (backend also: the e2e test passes).

> Solo or short on time? Skip the worktrees and run the **backend goal first** in one
> session (it's the risky half), then the UI goal. Same prompts.

While they run, you steer either session normally; the Stop hook keeps each honest. The
backend session needs `ANTHROPIC_API_KEY`; the UI session just needs the mock running.

## 5 · Integrate and deploy
When both goals report done:
```bash
git merge stream/backend
git merge stream/ui
```
Then ship to a live URL and run the smoke test against it — see `DEPLOY.md`. The live
URL + `python tests/test_contract_e2e.py https://<your-url>` passing is your
Orchestration evidence for the judges.

---

## Suggested first 30 minutes
1. Steps 0–2 (repo up, gates green, mock running). ~10 min.
2. Step 3 (one real run; fix any `# [MA]` name). ~10 min.
3. Step 4 (worktrees + paste both goals). ~10 min, then let them run and check in.
