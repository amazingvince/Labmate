"""
Mock backend for the Autopilot DS UI.

Implements the EXACT contract in API_CONTRACT.md with a scripted run, so the UI dev
can build with zero Anthropic setup. No API key, no SDK, no sandbox — just the
contract shapes on a realistic timeline, including the checkpoint.

Run:
  pip install flask flask-cors
  python mock_backend.py          # http://localhost:8000
  # open / , click Start, watch: baseline -> GBM -> leaking GBM -> checkpoint -> clean best -> done

Script: baseline(~0.73) -> GBM(~0.81) -> GBM+leak(~0.99, flagged) -> request_approval
("drop the leak") -> on approve, clean GBM(~0.84, best) -> done.
"""

import os
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder=None)
CORS(app)

# Set MOCK_FORCE_ERROR=1 to exercise the UI's error path.
FORCE_ERROR = os.environ.get("MOCK_FORCE_ERROR") == "1"

_lock = threading.Lock()
_state = {}
_cp_event = threading.Event()
_cp_reply = {}
_stop = threading.Event()


def reset():
    with _lock:
        _state.clear()
        _state.update(status="idle", session_id=None, feed=[], experiments=[], checkpoint=None)
    _cp_event.clear()
    _cp_reply.clear()
    _stop.clear()


reset()


def log(kind, text):
    with _lock:
        _state["feed"].append({"ts": time.time(), "kind": kind, "text": text})


def set_status(s):
    with _lock:
        _state["status"] = s


def add_experiment(d):
    with _lock:
        d = dict(d, id=uuid.uuid4().hex[:8], ts=time.time())
        _state["experiments"].append(d)
    metric = d.get("metrics", {})
    headline = next((f"{k}={metric[k]}" for k in ("auc", "f1", "accuracy") if k in metric), "logged")
    log("experiment", f"{d['name']} — {headline}")


def wait(s):
    """Sleep in small slices so Stop is responsive."""
    end = time.time() + s
    while time.time() < end:
        if _stop.is_set():
            raise _Stopped()
        time.sleep(0.1)


class _Stopped(Exception):
    pass


def script():
    try:
        if FORCE_ERROR:
            wait(1.5)
            raise RuntimeError("forced error for UI testing")

        with _lock:
            _state["session_id"] = "sesn_mock_" + uuid.uuid4().hex[:6]
        set_status("running")
        log("system", "Sandbox ready. Starting session.")
        wait(1.0)
        log("agent", "Generating the churn dataset and checking the target balance.")
        log("tool", "Bash"); wait(1.4)
        log("agent", "Churn rate ~21%. Establishing a logistic-regression baseline.")
        log("tool", "Bash"); wait(1.6)
        add_experiment({
            "name": "baseline logistic", "model_type": "LogisticRegression",
            "params": {"C": 1.0}, "metrics": {"auc": 0.731, "accuracy": 0.70},
            "cv_strategy": "5-fold stratified", "hypothesis": "establish a baseline",
            "leakage_suspected": False, "notes": "",
        })
        wait(1.2)
        log("agent", "Trying gradient boosting with light tuning.")
        log("tool", "Bash"); wait(1.8)
        add_experiment({
            "name": "gbm depth=3", "model_type": "GradientBoosting",
            "params": {"max_depth": 3, "n_estimators": 200, "learning_rate": 0.05},
            "metrics": {"auc": 0.812, "accuracy": 0.75}, "cv_strategy": "5-fold stratified",
            "hypothesis": "non-linear interactions help", "leakage_suspected": False, "notes": "",
        })
        wait(1.2)
        log("agent", "Adding all available columns, including days_since_cancellation.")
        log("tool", "Bash"); wait(1.8)
        add_experiment({
            "name": "gbm + all features", "model_type": "GradientBoosting",
            "params": {"max_depth": 3, "n_estimators": 200, "learning_rate": 0.05},
            "metrics": {"auc": 0.992, "accuracy": 0.97}, "cv_strategy": "5-fold stratified",
            "hypothesis": "more features help",
            "leakage_suspected": True,
            "notes": "0.99 AUC is suspicious — reviewing for leakage.",
        })
        wait(1.0)
        log("agent", "That 0.99 is a red flag. Reviewing feature provenance before trusting it.")
        log("tool", "Bash"); wait(1.6)

        # ---- checkpoint ----
        cid = uuid.uuid4().hex[:8]
        with _lock:
            _state["checkpoint"] = {
                "id": cid,
                "summary": "Drop a leaking feature and re-run",
                "proposed_action": "Remove days_since_cancellation (only populated after a customer churns) and re-fit the GBM.",
                "rationale": "The 0.992 AUC comes entirely from days_since_cancellation, which is unavailable at prediction time — classic target leakage.",
            }
            _state["status"] = "waiting"
        log("system", "Checkpoint: drop a leaking feature and re-run")

        _cp_event.wait()  # block until /api/checkpoint resolves it
        if _stop.is_set():
            raise _Stopped()
        decision = _cp_reply.get("decision")
        feedback = _cp_reply.get("feedback", "").strip()
        with _lock:
            _state["checkpoint"] = None
            _state["status"] = "running"
        log("system", f"You resolved the checkpoint → {decision}")
        wait(0.8)

        if decision == "reject":
            log("agent", f"Understood. Incorporating your guidance: {feedback or '(none given)'}.")
            wait(1.4)

        log("agent", "Dropping days_since_cancellation and re-fitting on prediction-time features only.")
        log("tool", "Bash"); wait(1.8)
        add_experiment({
            "name": "gbm clean (no leak)", "model_type": "GradientBoosting",
            "params": {"max_depth": 4, "n_estimators": 250, "learning_rate": 0.05},
            "metrics": {"auc": 0.842, "accuracy": 0.78}, "cv_strategy": "5-fold stratified",
            "hypothesis": "honest model on prediction-time features", "leakage_suspected": False,
            "notes": "Best trustworthy model. Beats the 0.71 production baseline honestly.",
        })
        wait(0.8)
        log("agent", "Final: 0.842 held-out AUC, no leakage. Beats the 0.71 production model honestly.")
        set_status("done")
        log("system", "Run complete.")

    except _Stopped:
        set_status("stopped")
        log("system", "Run stopped by user.")
    except Exception as e:  # noqa: BLE001
        set_status("error")
        log("error", f"{type(e).__name__}: {e}")


# ===========================================================================
# Contract endpoints
# ===========================================================================
@app.post("/api/run")
def start_run():
    with _lock:
        if _state["status"] in ("running", "waiting"):
            return jsonify({"error": "a run is already in progress"}), 409
    reset()
    threading.Thread(target=script, daemon=True).start()
    return jsonify({"ok": True})


@app.get("/api/state")
def state():
    with _lock:
        return jsonify(dict(_state, feed=_state["feed"][-200:]))


@app.post("/api/steer")
def steer():
    msg = (request.json or {}).get("message", "").strip()
    if not msg:
        return jsonify({"error": "empty message"}), 400
    log("system", f"You steered: {msg}")
    log("agent", f"Noted — prioritizing: {msg}")
    return jsonify({"ok": True})


@app.post("/api/checkpoint")
def checkpoint():
    body = request.json or {}
    decision = body.get("decision")
    if decision not in ("approve", "reject"):
        return jsonify({"error": "decision must be approve or reject"}), 400
    with _lock:
        cp = _state.get("checkpoint")
        if not cp or cp.get("id") != body.get("id"):
            return jsonify({"error": "unknown checkpoint"}), 404
    _cp_reply["decision"] = decision
    _cp_reply["feedback"] = body.get("feedback", "")
    _cp_event.set()
    return jsonify({"ok": True})


@app.post("/api/stop")
def stop():
    _stop.set()
    _cp_event.set()  # release a waiting checkpoint so the thread can exit
    set_status("stopped")
    log("system", "Run stopped by user.")
    return jsonify({"ok": True})


FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "frontend")


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


if __name__ == "__main__":
    print("Mock backend on http://localhost:8000  (no API key needed)")
    app.run(host="0.0.0.0", port=8000, threaded=True)
