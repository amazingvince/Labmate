#!/usr/bin/env python3
"""
End-to-end contract conformance test.

Runs against ANY backend that serves API_CONTRACT.md — the real backend (with a live
ANTHROPIC_API_KEY) or mock_backend.py. Same assertions for both, because they emit
the same contract. This is:
  - the backend stream's headline rubric criterion (live behavior), and
  - the integration gate (run it with the real UI in front to walk the DoD).

Usage:
  # against the mock (fast, no key):
  python mock_backend.py &        # in another shell
  python tests/test_contract_e2e.py http://localhost:8000

  # against the real backend (needs ANTHROPIC_API_KEY, ~1-3 min):
  python backend/app.py &
  python tests/test_contract_e2e.py http://localhost:8000

Exit 0 = conformant, 1 = a check failed (prints what).
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"
DEADLINE_S = int(sys.argv[2]) if len(sys.argv) > 2 else 240  # generous for the real agent

FEED_KINDS = {"agent", "tool", "experiment", "system", "error"}
STATUSES = {"idle", "running", "waiting", "done", "error", "stopped"}


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)


def state():
    code, body = req("GET", "/api/state")
    assert code == 200, f"/api/state returned {code}"
    return body


def fail(msg):
    print(f"\nCONFORMANCE FAILED: {msg}")
    sys.exit(1)


def wait_for(predicate, what, timeout):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = state()
        if predicate(last):
            return last
        time.sleep(0.5)
    fail(f"timed out after {timeout}s waiting for: {what} (last status={last.get('status') if last else '?'})")


print(f"Testing backend at {BASE}")

# --- initial state shape -------------------------------------------------
s = state()
for k in ("status", "session_id", "feed", "experiments", "checkpoint"):
    if k not in s:
        fail(f"State missing key '{k}'")
if s["status"] not in STATUSES:
    fail(f"unknown status '{s['status']}'")
print(f"  initial state OK (status={s['status']})")

# --- start + double-start guard -----------------------------------------
code, body = req("POST", "/api/run")
if code != 200 or body != {"ok": True}:
    fail(f"/api/run expected 200 {{ok:true}}, got {code} {body}")
code, _ = req("POST", "/api/run")
if code != 409:
    fail(f"double /api/run should be 409, got {code}")
print("  run started; double-start -> 409 OK")

# --- a checkpoint must appear (the leakage review) -----------------------
s = wait_for(lambda x: x["status"] == "waiting" and x.get("checkpoint"),
             "the leakage checkpoint (status=waiting)", DEADLINE_S)
cp = s["checkpoint"]
for k in ("id", "summary", "proposed_action"):
    if k not in cp:
        fail(f"checkpoint missing key '{k}'")
print(f"  checkpoint appeared: {cp['summary']!r} ({len(s['experiments'])} experiments so far)")

# feed + experiment shapes are valid by now
for f in s["feed"]:
    if not ({"ts", "kind", "text"} <= set(f)) or f["kind"] not in FEED_KINDS:
        fail(f"bad feed item: {f}")
for e in s["experiments"]:
    if not ({"id", "name", "model_type", "metrics"} <= set(e)):
        fail(f"experiment missing required keys: {e}")
if not any(e.get("leakage_suspected") for e in s["experiments"]):
    fail("expected at least one experiment flagged leakage_suspected before the checkpoint")
print("  feed + experiment shapes OK; a leaking experiment is flagged")

# --- checkpoint validation -----------------------------------------------
code, _ = req("POST", "/api/checkpoint", {"id": cp["id"], "decision": "maybe"})
if code != 400:
    fail(f"bad decision should be 400, got {code}")
code, _ = req("POST", "/api/checkpoint", {"id": "does-not-exist", "decision": "approve"})
if code != 404:
    fail(f"unknown checkpoint id should be 404, got {code}")
code, body = req("POST", "/api/checkpoint", {"id": cp["id"], "decision": "approve"})
if code != 200 or body != {"ok": True}:
    fail(f"approve expected 200 {{ok:true}}, got {code} {body}")
print("  checkpoint 400/404 validation OK; approved")

# --- resumes and finishes with an honest best ----------------------------
s = wait_for(lambda x: x["status"] in ("done", "error", "stopped"),
             "the run to finish (status=done)", DEADLINE_S)
if s["status"] != "done":
    fail(f"run ended as '{s['status']}', expected 'done'")


def auc(e):
    return e["metrics"].get("auc", -1)


# The leaky run stays in history (correctly flagged) — that's expected, so the
# global-max AUC is allowed to be the leaky one. The real success criterion is
# that an HONEST (non-leaky) model was produced after the checkpoint and beats the
# 0.71 production baseline. That proves the agent dropped the leak and still won.
clean = [e for e in s["experiments"] if not e.get("leakage_suspected")]
if not clean:
    fail("no non-leaky experiment exists after approval")
honest_best = max(clean, key=auc)
if auc(honest_best) <= 0.71:
    fail(f"best honest model is {honest_best['name']} (auc={auc(honest_best)}), "
         f"which does not beat the 0.71 production baseline — the leak fix lost the win")
print(f"  finished: {len(s['experiments'])} experiments; honest best = "
      f"{honest_best['name']} (auc={auc(honest_best)}), leaky run flagged + retained")

# --- steer + stop validation ---------------------------------------------
code, _ = req("POST", "/api/steer", {"message": ""})
if code != 400:
    fail(f"empty steer should be 400, got {code}")
code, body = req("POST", "/api/steer", {"message": "focus on gradient boosting"})
if code != 200:
    fail(f"steer should be 200, got {code}")
code, body = req("POST", "/api/stop")
if code != 200:
    fail(f"stop should be 200, got {code}")
print("  steer 400/200 + stop 200 OK")

print("\nCONTRACT CONFORMANCE: PASS")
sys.exit(0)
