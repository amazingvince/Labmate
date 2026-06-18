/**
 * Agent runtime HTTP/SSE server.
 *
 *   POST /agent/start            { study_id }      → start a session + loop (idempotent)
 *   GET  /agent/:studyId/stream  (SSE)             → SUBSCRIBE to a study's agent events
 *   POST /agent/:studyId/message { text }          → inject human guidance (409 if ended)
 *   GET  /healthz
 *
 * Uses only Node built-ins (node:http) to avoid a framework dependency. The control
 * plane (apps/web) proxies /agent/:id/stream and /agent/:id/message through to the
 * cockpit; it also POSTs /agent/start when a study is created.
 *
 * SSE CONTRACT (C9):
 *   - GET /stream is a PURE SUBSCRIBE. It NEVER starts or restarts a study — that was
 *     the root cause of "opening the Live tab re-runs a finished study". Session
 *     creation is explicit (POST /agent/start, or the Worker's create-study trigger).
 *   - Every frame carries a monotonic `id:` (a per-study sequence number). On reconnect
 *     we honor the `Last-Event-ID` request header: replay only buffered frames AFTER it,
 *     deduped, so a dropped connection resumes without gaps or repeats.
 *   - If a study has no live/recent session, we emit ONE terminal `session.ended` frame
 *     and close — we never hang the connection open.
 *   - When the loop finishes/errors it emits a terminal frame (study.done / loop.error /
 *     session.ended). The server then res.end()s every subscriber, clears heartbeat
 *     timers, marks the entry inactive, and schedules the registry entry for deletion
 *     after a grace window (so a late reconnect can still replay the tail).
 *
 * The wire format stays backward-compatible with the Worker proxy + the cockpit
 * useAgentStream: named events use `event:`+`data:`, default frames use bare `data:`.
 * We only ADD `id:` lines and the terminal frames above.
 *
 * DEPLOYMENT NOTE: wrapped as a Modal web_server (modal_app.py) pinned to a SINGLE
 * container — the registry below is per-process in-memory state.
 */
import http from "node:http";
import { config, assertRuntimeConfig } from "./config.mjs";
import * as sdk from "./anthropic.mjs";
import { makeControlPlaneClient } from "./controlplane.mjs";
import { makeDispatcher } from "./dispatch.mjs";
import { runStudyLoop } from "./loop.mjs";
import { fetchStudyConstraints, formatContractReminder, constraintsSignature } from "./constraints.mjs";

// Terminal event kinds: when one is emitted, the loop is over. These MATCH the
// cockpit's TERMINAL set (useAgentStream) so EventSource stops reconnecting.
const TERMINAL_KINDS = new Set(["study.done", "session.ended", "loop.finished", "loop.error"]);

// In-memory registry of studies → SSE subscribers + a replayable, sequenced buffer.
//   { subscribers:Set<res>, buffer:[{seq,evt}], seq, sessionId, active, controlPlane,
//     heartbeats:Map<res,timer>, gcTimer }
const studies = new Map();

/** Format one SSE frame: an `id:` line (monotonic seq) then a bare `data:` JSON line.
 *  Bare `data:` (the default SSE channel) is what the cockpit's es.onmessage handler
 *  reads — it routes on the payload's `kind`, including the terminal kinds. We add ONLY
 *  the `id:` line on top of the prior wire format, so the Worker proxy and cockpit are
 *  unchanged. (The Worker emits its own named `info`/`error` frames; the runtime keeps
 *  everything on the default channel.) */
function frame(seq, evt) {
  return `id: ${seq}\ndata: ${JSON.stringify(evt)}\n\n`;
}

function emitter(studyId) {
  return (evt) => {
    const entry = studies.get(studyId);
    if (!entry) return;
    const seq = ++entry.seq;
    entry.buffer.push({ seq, evt });
    if (entry.buffer.length > 500) entry.buffer.shift();
    const line = frame(seq, evt);
    for (const res of entry.subscribers) {
      try {
        res.write(line);
      } catch {
        /* a dead socket is reaped by its own 'close' handler */
      }
    }
    // Terminal frame: close every subscriber cleanly, stop heartbeats, mark the entry
    // inactive, and schedule it for GC after a grace window (late reconnects can still
    // replay the buffered tail until then).
    if (TERMINAL_KINDS.has(evt?.kind)) {
      finishStudy(studyId);
    }
  };
}

/** Tear down a finished study's live resources but keep its buffer for the grace
 *  window so a reconnecting client can replay the tail (then GC the whole entry). */
function finishStudy(studyId) {
  const entry = studies.get(studyId);
  if (!entry || !entry.active) return; // idempotent — terminal frame may arrive twice
  entry.active = false;
  for (const res of entry.subscribers) {
    const hb = entry.heartbeats.get(res);
    if (hb) clearInterval(hb);
    entry.heartbeats.delete(res);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  }
  entry.subscribers.clear();
  if (entry.gcTimer) clearTimeout(entry.gcTimer);
  entry.gcTimer = setTimeout(() => {
    studies.delete(studyId);
  }, Math.max(1, config.sessionGraceSeconds) * 1000);
  if (entry.gcTimer.unref) entry.gcTimer.unref();
}

/** Adapter the loop uses; real SDK here, swapped for a stub in tests. */
function realAgentAdapter() {
  return {
    createSession: sdk.createSession,
    sendUserMessage: sdk.sendUserMessage,
    sendToolResult: sdk.sendToolResult,
    streamEvents: sdk.streamEvents,
    // getOutcome: sdk.getOutcome, // wire when the Outcomes preview is enabled
  };
}

/**
 * Start (or no-op return) a study's session + loop. EXPLICIT only — called by
 * POST /agent/start, never as a side effect of GET /stream. Idempotent: a second
 * call while the first is active returns the same entry instead of re-kicking.
 */
function startStudy(studyId) {
  const existing = studies.get(studyId);
  if (existing && existing.active) return existing; // already running — never re-kick

  const controlPlane = makeControlPlaneClient();
  // Shared between the server's /message handler and the loop's nudge: the signature of
  // the LAST contract we surfaced to the LLM, so neither re-announces an unchanged
  // contract — but a change (from either inject path or out-of-band /api/feedback) does
  // reach the model exactly once on the next opportunity.
  const constraintTracker = { lastSig: "" };
  const entry = {
    subscribers: new Set(),
    buffer: [],
    seq: 0,
    sessionId: null,
    active: true,
    controlPlane,
    constraintTracker,
    heartbeats: new Map(),
    gcTimer: null,
  };
  // Replace any stale (finished) entry, cancelling its pending GC.
  if (existing?.gcTimer) clearTimeout(existing.gcTimer);
  studies.set(studyId, entry);

  const modal = { url: config.modalRunnerUrl() };
  const dispatcher = makeDispatcher({
    controlPlane,
    modal,
    autoApprove: config.autoApprove,
    approvalDelayMs: config.approvalDelayMs,
    budget: { defaultBudgetSeconds: config.defaultBudgetSeconds, defaultMaxTrials: config.defaultMaxTrials },
    onApprovalNeeded: async (input, res) =>
      emitter(studyId)({
        kind: "approval.needed",
        input,
        res,
        auto_approve_in_ms: config.autoApprove ? config.approvalDelayMs : null,
      }),
  });

  // Capture the session id the moment the loop creates it, so a human can inject a
  // "suggest changes" message mid-run (not only after the loop finishes).
  const baseEmit = emitter(studyId);
  const emit = (evt) => {
    if (evt?.kind === "session.created" && evt.session_id) entry.sessionId = evt.session_id;
    baseEmit(evt);
  };

  // Fire-and-forget the loop; it runs until done or the session ends. The loop is
  // contracted to emit exactly one terminal frame, which drives finishStudy() above.
  runStudyLoop({
    studyId,
    agent: realAgentAdapter(),
    dispatcher,
    controlPlane,
    emit,
    opts: {
      agentId: config.agentId(),
      environmentId: config.environmentId(),
      maxToolCalls: config.maxToolCallsPerSession,
      maxSessionSeconds: config.maxSessionSeconds,
      outcomesEnabled: config.outcomesEnabled,
      constraintTracker,
    },
  })
    .then((r) => {
      entry.sessionId = r.sessionId ?? entry.sessionId;
      // loop.finished is a terminal frame too — finishStudy fires from emitter().
      emit({ kind: "loop.finished", study_id: studyId, ...r });
    })
    .catch((err) => {
      // A throw escaped the loop's own try/finally (should be rare). Emit a terminal
      // loop.error so subscribers close instead of hanging to the SSE idle timeout.
      emit({ kind: "loop.error", study_id: studyId, error: String(err?.message ?? err), terminal: true });
    });

  return entry;
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ["agent", ":id", "stream"]

  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/agent/start") {
    const body = await readBody(req);
    if (!body.study_id) return send(res, 400, { error: "study_id required" });
    try {
      assertRuntimeConfig();
    } catch (e) {
      return send(res, 503, { error: "config", detail: String(e.message) });
    }
    const entry = startStudy(body.study_id);
    return send(res, 202, {
      status: entry.active ? "started" : "finished",
      study_id: body.study_id,
    });
  }

  if (req.method === "GET" && parts[0] === "agent" && parts[2] === "stream") {
    const studyId = decodeURIComponent(parts[1]);
    const entry = studies.get(studyId);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // PURE SUBSCRIBE — never starts a study. No entry (or a fully GC'd one) means
    // there is no active session: emit ONE terminal session.ended frame and close,
    // rather than hanging the connection open forever.
    if (!entry) {
      res.write(frame(1, { kind: "session.ended", study_id: studyId, reason: "no_active_session" }));
      res.end();
      return;
    }

    // Honor Last-Event-ID (header on reconnect, or ?last_event_id= for clients that
    // can't set headers, e.g. EventSource). Replay only buffered frames AFTER it.
    const headerId = req.headers["last-event-id"];
    const queryId = url.searchParams.get("last_event_id");
    const lastSeen = Number(headerId ?? queryId ?? 0) || 0;
    for (const { seq, evt } of entry.buffer) {
      if (seq > lastSeen) res.write(frame(seq, evt));
    }

    // If the study already finished (inactive but still within its grace window), the
    // replayed buffer ends with a terminal frame — close now; don't keep it open.
    if (!entry.active) {
      res.end();
      return;
    }

    entry.subscribers.add(res);
    // Heartbeat: SSE comment lines (ignored by EventSource) keep intermediaries (the
    // Cloudflare proxy, the Modal edge) from closing the idle connection and let us
    // detect a dead socket. Cleared on disconnect and at terminal.
    const heartbeat = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 20000);
    if (heartbeat.unref) heartbeat.unref();
    entry.heartbeats.set(res, heartbeat);
    req.on("close", () => {
      clearInterval(heartbeat);
      entry.heartbeats.delete(res);
      entry.subscribers.delete(res);
    });
    return;
  }

  if (req.method === "POST" && parts[0] === "agent" && parts[2] === "message") {
    const studyId = decodeURIComponent(parts[1]);
    const body = await readBody(req);
    const entry = studies.get(studyId);
    if (!entry) return send(res, 409, { error: "session_not_ready" });
    // The loop has ended — guidance would be silently dropped. Tell the caller.
    if (!entry.active) return send(res, 409, { error: "session_finished" });
    if (!entry.sessionId) return send(res, 409, { error: "session_not_ready" });
    if (!body.text) return send(res, 400, { error: "text required" });

    // C1 — FIRST record the guidance to the control plane as type:'human_feedback'
    // (NOT 'approval'): that's the type the Worker's NL parser inspects to extract
    // structured constraints (primary_metric / FPR guardrail / banned columns) and
    // CAUSALLY mutate study.constraints. We record BEFORE injecting so the reminder we
    // hand the model below reflects the just-applied contract. Best-effort: never fail
    // the inject on a feedback write hiccup.
    let constraintsChanged = false;
    try {
      const fb = await entry.controlPlane.post("/api/feedback", {
        study_id: studyId,
        type: "human_feedback",
        scope: "study",
        content: body.text,
      });
      constraintsChanged = Boolean(fb && !fb.error && fb.constraints_changed);
    } catch {
      /* the guidance still reaches the agent session; feedback log is best-effort */
    }

    // Re-surface the CURRENT enforced contract to the LLM along with the human's note,
    // so it RE-PLANS toward the (possibly tightened) bound instead of only learning of
    // the change when a launch is rejected. Fetch is best-effort; on any failure we just
    // inject the raw note (the prior behavior). The signature is recorded so the loop's
    // periodic nudge doesn't redundantly re-announce the same contract.
    let injected = `[human guidance] ${body.text}`;
    try {
      const constraints = await fetchStudyConstraints(entry.controlPlane, studyId);
      const reminder = formatContractReminder(constraints);
      if (reminder) {
        injected += `\n${reminder}`;
        // Record what we just surfaced so the loop's nudge won't re-announce it.
        if (entry.constraintTracker) entry.constraintTracker.lastSig = constraintsSignature(constraints);
      }
    } catch {
      /* awareness reminder is best-effort; never block the human's guidance */
    }

    try {
      await sdk.sendUserMessage(entry.sessionId, injected);
    } catch (e) {
      return send(res, 502, { error: "guidance_send_failed", detail: String(e?.message ?? e) });
    }
    emitter(studyId)({ kind: "human.guidance", study_id: studyId, text: body.text, constraints_changed: constraintsChanged });

    return send(res, 202, { status: "queued" });
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(config.port, () => {
  console.info(`Labmate agent runtime listening on :${config.port}`);
});
