"""
Autopilot DS — backend.

One file on purpose: a hackathon wants one thing to run and one thing to read.

Shape:
  - Store ............ thread-safe in-memory state the UI polls (runs as the tracker)
  - driver() ......... background thread that drives the Managed Agents session:
                       opens the event stream, relays agent activity to the Store,
                       answers the log_experiment custom tool, and parks a checkpoint
                       when request_approval fires until the human resolves it.
  - Flask routes ..... start a run, poll state, steer, resolve a checkpoint, stop.

Every Anthropic SDK call is inside this file and tagged `# [MA]` so the handful of
beta field names you may need to confirm are easy to find.

Run:
  export ANTHROPIC_API_KEY=sk-ant-...
  pip install -r requirements.txt
  python app.py
  # open http://localhost:8000
"""

import os
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from anthropic import Anthropic
import agent_config as cfg

# The SDK reads ANTHROPIC_API_KEY from the environment.
# [MA] The SDK sets the `managed-agents-2026-04-01` beta header automatically.
client = Anthropic()

app = Flask(__name__, static_folder=None)
CORS(app)


# ===========================================================================
# Store — the live state the browser polls. Swap this for a trackio-backed
# store later; the rest of the app only touches these methods.
# ===========================================================================
class Store:
    def __init__(self):
        self._lock = threading.Lock()
        self.reset()

    def reset(self):
        with self._lock:
            self.status = "idle"          # idle | running | waiting | done | error | stopped
            self.session_id = None
            self.feed = []                # [{ts, kind, text}]  kind: agent|tool|experiment|system|error
            self.experiments = []         # [{id, ...log_experiment input...}]
            self.checkpoint = None        # {id, summary, proposed_action, rationale} when awaiting human
            self._checkpoint_reply = {}   # id -> {decision, feedback}
            self._checkpoint_event = {}   # id -> threading.Event
            self.steer_queue = []         # pending steering messages to forward
            self.stop_flag = False

    # ---- feed / status -------------------------------------------------
    def log(self, kind, text):
        with self._lock:
            self.feed.append({"ts": time.time(), "kind": kind, "text": text})

    def set_status(self, s):
        with self._lock:
            self.status = s

    def set_session(self, sid):
        with self._lock:
            self.session_id = sid

    # ---- experiments ---------------------------------------------------
    def add_experiment(self, data):
        with self._lock:
            data = dict(data)
            data["id"] = uuid.uuid4().hex[:8]
            data["ts"] = time.time()
            self.experiments.append(data)
            return data

    # ---- checkpoints ---------------------------------------------------
    def open_checkpoint(self, data):
        """Register a pending checkpoint and return (id, event) to block on."""
        cid = uuid.uuid4().hex[:8]
        ev = threading.Event()
        with self._lock:
            self.checkpoint = {"id": cid, **data}
            self._checkpoint_event[cid] = ev
            self.status = "waiting"
        return cid, ev

    def resolve_checkpoint(self, cid, decision, feedback=""):
        with self._lock:
            ev = self._checkpoint_event.get(cid)
            if not ev:
                return False
            self._checkpoint_reply[cid] = {"decision": decision, "feedback": feedback}
            if self.checkpoint and self.checkpoint["id"] == cid:
                self.checkpoint = None
            self.status = "running"
            ev.set()
            return True

    def checkpoint_reply(self, cid):
        with self._lock:
            return self._checkpoint_reply.get(cid, {})

    # ---- steering ------------------------------------------------------
    def queue_steer(self, text):
        with self._lock:
            self.steer_queue.append(text)

    def drain_steer(self):
        with self._lock:
            msgs, self.steer_queue = self.steer_queue, []
            return msgs

    def request_stop(self):
        with self._lock:
            self.stop_flag = True
            # release any waiting checkpoint so the thread can exit
            for ev in self._checkpoint_event.values():
                ev.set()

    def stopping(self):
        with self._lock:
            return self.stop_flag

    # ---- snapshot for the UI ------------------------------------------
    def snapshot(self):
        with self._lock:
            return {
                "status": self.status,
                "session_id": self.session_id,
                "feed": self.feed[-200:],
                "experiments": self.experiments,
                "checkpoint": self.checkpoint,
            }


store = Store()


# ===========================================================================
# Helpers to read event fields defensively. The SDK returns objects with
# attributes (event.type, event.content, event.name, ...). We use getattr so a
# minor shape difference degrades gracefully instead of crashing the thread.
# ===========================================================================
def ev_get(event, *names, default=None):
    for n in names:
        v = getattr(event, n, None)
        if v is not None:
            return v
    return default


def text_from_content(content):
    parts = []
    for block in content or []:
        t = getattr(block, "text", None)
        if t is None and isinstance(block, dict):
            t = block.get("text")
        if t:
            parts.append(t)
    return "".join(parts)


def send(events):
    """[MA] Send user events to the running session."""
    client.beta.sessions.events.send(store.session_id, events=events)  # [MA]


# ===========================================================================
# The session driver — runs in a background thread.
# ===========================================================================
def driver():
    try:
        # ---- 1. Create the agent ----------------------------------------
        # [MA] Confirm the system-prompt param name (system / system_prompt /
        # instructions) against the agent-setup docs.
        tools = [
            {
                "type": "agent_toolset_20260401",  # [MA] built-in bash/files/web
                "default_config": {"permission_policy": {"type": "always_allow"}},
            },
            *cfg.CUSTOM_TOOLS,
        ]
        agent = client.beta.agents.create(  # [MA]
            name="Autopilot DS",
            model=cfg.MODEL,
            system=cfg.SYSTEM_PROMPT,
            tools=tools,
        )
        store.log("system", "Agent created. Provisioning sandbox…")

        # ---- 2. Create the environment (Anthropic-managed cloud sandbox) -
        environment = client.beta.environments.create()  # [MA] default cloud sandbox
        store.log("system", "Sandbox ready. Starting session.")

        # ---- 3. Create the session --------------------------------------
        session = client.beta.sessions.create(  # [MA]
            agent=agent.id,
            environment_id=environment.id,
            title="Autopilot DS run",
        )
        store.set_session(session.id)
        store.set_status("running")
        store.log("system", "Session started. Sending the task.")

        # ---- 4. Kick off, then drive the stream-to-idle loop ------------
        send([{"type": "user.message",
               "content": [{"type": "text", "text": cfg.KICKOFF_TASK}]}])

        while not store.stopping():
            pending = _drain_stream_to_idle()
            if store.stopping():
                break
            if pending == "done":
                store.set_status("done")
                store.log("system", "Run complete.")
                break
            # Between turns the session pauses; forward any steering the human queued.
            for msg in store.drain_steer():
                store.log("system", f"You steered: {msg}")
                send([{"type": "user.message",
                       "content": [{"type": "text", "text": msg}]}])
            if pending == "idle-empty" and not store.drain_steer():
                # idle with nothing pending and no steering: nudge once, else finish
                time.sleep(0.5)

    except Exception as e:  # noqa: BLE001 — surface anything to the UI for a demo
        store.set_status("error")
        store.log("error", f"{type(e).__name__}: {e}")


def _drain_stream_to_idle():
    """
    Open the event stream and process events until the session goes idle.
    Returns "done" if the agent finished, otherwise "idle-empty".
    Handles custom tools inline:
      - log_experiment   -> record + auto-return result, keep going
      - request_approval -> park a checkpoint, block for the human, return result
    """
    # [MA] Open the stream BEFORE the agent acts so no events are lost in the race.
    with client.beta.sessions.events.stream(store.session_id) as stream:  # [MA]
        for event in stream:
            if store.stopping():
                return "idle-empty"
            etype = getattr(event, "type", "")

            if etype == "agent.message":
                txt = text_from_content(getattr(event, "content", None))
                if txt.strip():
                    store.log("agent", txt.strip())

            elif etype == "agent.tool_use":
                name = ev_get(event, "name", default="tool")
                store.log("tool", f"{name}")

            elif etype == "agent.custom_tool_use":
                name = ev_get(event, "name")
                tool_use_id = ev_get(event, "id", "tool_use_id")
                tinput = ev_get(event, "input", default={}) or {}

                if name == "log_experiment":
                    rec = store.add_experiment(tinput)
                    metric = _headline_metric(rec.get("metrics", {}))
                    store.log("experiment", f"{rec.get('name','experiment')} — {metric}")
                    # [MA] Return the custom tool result so the agent continues.
                    send([{"type": "user.custom_tool_result",
                           "tool_use_id": tool_use_id,
                           "content": "logged"}])

                elif name == "request_approval":
                    store.log("system", f"Checkpoint: {tinput.get('summary','(awaiting your decision)')}")
                    cid, ev = store.open_checkpoint({
                        "summary": tinput.get("summary", ""),
                        "proposed_action": tinput.get("proposed_action", ""),
                        "rationale": tinput.get("rationale", ""),
                        "tool_use_id": tool_use_id,
                    })
                    ev.wait()  # block this thread until the human resolves it
                    if store.stopping():
                        return "idle-empty"
                    reply = store.checkpoint_reply(cid)
                    if reply.get("decision") == "approve":
                        result = "APPROVED by the human. Proceed."
                    else:
                        fb = reply.get("feedback", "").strip() or "Do not proceed as proposed; reconsider."
                        result = f"CHANGES REQUESTED by the human: {fb}"
                    store.log("system", f"You resolved the checkpoint → {reply.get('decision')}")
                    send([{"type": "user.custom_tool_result",
                           "tool_use_id": tool_use_id,
                           "content": result}])

                else:
                    # Unknown custom tool — return empty so we don't hang the agent.
                    send([{"type": "user.custom_tool_result",
                           "tool_use_id": tool_use_id, "content": "ok"}])

            elif etype == "session.error":
                store.log("error", str(ev_get(event, "message", default="session error")))

            elif etype in ("session.status_idle", "session.status_terminated"):
                stop = ev_get(event, "stop_reason", default=None)
                stop_type = getattr(stop, "type", None) if stop else None
                if etype == "session.status_terminated":
                    return "done"
                # idle: done if the agent ended its turn cleanly, else just paused
                return "done" if stop_type == "end_turn" else "idle-empty"

    return "idle-empty"


def _headline_metric(metrics):
    if not isinstance(metrics, dict) or not metrics:
        return "logged"
    for key in ("auc", "roc_auc", "f1", "accuracy"):
        if key in metrics:
            return f"{key}={metrics[key]}"
    k = next(iter(metrics))
    return f"{k}={metrics[k]}"


# ===========================================================================
# HTTP API
# ===========================================================================
@app.post("/api/run")
def start_run():
    if store.status in ("running", "waiting"):
        return jsonify({"error": "a run is already in progress"}), 409
    store.reset()
    threading.Thread(target=driver, daemon=True).start()
    return jsonify({"ok": True})


@app.get("/api/state")
def state():
    return jsonify(store.snapshot())


@app.post("/api/steer")
def steer():
    msg = (request.json or {}).get("message", "").strip()
    if not msg:
        return jsonify({"error": "empty message"}), 400
    store.queue_steer(msg)
    # If the session is mid-turn we can also push immediately; queuing covers
    # the between-turns case. For a demo, queue-and-forward is reliable.
    return jsonify({"ok": True})


@app.post("/api/checkpoint")
def checkpoint():
    body = request.json or {}
    cid = body.get("id")
    decision = body.get("decision")  # "approve" | "reject"
    feedback = body.get("feedback", "")
    if decision not in ("approve", "reject"):
        return jsonify({"error": "decision must be approve or reject"}), 400
    ok = store.resolve_checkpoint(cid, decision, feedback)
    return (jsonify({"ok": True}) if ok else (jsonify({"error": "unknown checkpoint"}), 404))


@app.post("/api/stop")
def stop():
    store.request_stop()
    try:
        if store.session_id:
            # [MA] Confirm the stop method against session-operations docs
            # (interrupt vs delete). We also set a local flag so the driver exits
            # regardless of which call the beta exposes.
            client.beta.sessions.interrupt(store.session_id)  # [MA]
    except Exception:
        pass
    store.set_status("stopped")
    store.log("system", "Run stopped by user.")
    return jsonify({"ok": True})


# ---- serve the single-page UI --------------------------------------------
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, threaded=True)
