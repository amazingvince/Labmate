/**
 * Agent runtime HTTP/SSE server.
 *
 *   POST /agent/start            { study_id }      → start a session + loop
 *   GET  /agent/:studyId/stream  (SSE)             → live agent events for the cockpit
 *   POST /agent/:studyId/message { text }          → inject a human "suggest changes" msg
 *   GET  /healthz
 *
 * Uses only Node built-ins (node:http) to avoid a framework dependency. The
 * control plane (apps/web) can proxy /agent/:id/stream through to the cockpit, or
 * the cockpit can hit this directly in local dev.
 *
 * DEPLOYMENT NOTE: for the hackathon you can wrap this as a Modal app — a web
 * endpoint for the POST routes plus a long-running function that holds the event
 * stream — so there's no separate host to manage. The loop code is unchanged;
 * only the process entrypoint differs.
 */
import http from "node:http";
import { config, assertRuntimeConfig } from "./config.mjs";
import * as sdk from "./anthropic.mjs";
import { makeControlPlaneClient } from "./controlplane.mjs";
import { makeDispatcher } from "./dispatch.mjs";
import { runStudyLoop } from "./loop.mjs";

// In-memory registry of live studies → SSE subscribers and last events.
const studies = new Map(); // study_id → { subscribers:Set<res>, buffer:[], sessionId, inject }

function emitter(studyId) {
  return (evt) => {
    const entry = studies.get(studyId);
    if (!entry) return;
    entry.buffer.push(evt);
    if (entry.buffer.length > 500) entry.buffer.shift();
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of entry.subscribers) res.write(line);
  };
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

async function startStudy(studyId) {
  if (studies.has(studyId)) return studies.get(studyId);
  const entry = { subscribers: new Set(), buffer: [], sessionId: null, injectQueue: [] };
  studies.set(studyId, entry);

  const controlPlane = makeControlPlaneClient();
  const modal = { url: config.modalRunnerUrl() };
  const dispatcher = makeDispatcher({
    controlPlane,
    modal,
    onApprovalNeeded: async (input, res) => emitter(studyId)({ kind: "approval.needed", input, res }),
  });

  // Capture the session id the moment the loop creates it, so a human can inject
  // a "suggest changes" message mid-run (not only after the loop finishes).
  const baseEmit = emitter(studyId);
  const emit = (evt) => {
    if (evt?.kind === "session.created" && evt.session_id) entry.sessionId = evt.session_id;
    baseEmit(evt);
  };

  // Fire-and-forget the loop; it runs until done or the session ends.
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
      outcomesEnabled: config.outcomesEnabled,
    },
  })
    .then((r) => {
      entry.sessionId = r.sessionId;
      emit({ kind: "loop.finished", study_id: studyId, ...r });
    })
    .catch((err) => emit({ kind: "loop.error", study_id: studyId, error: String(err?.message ?? err) }));

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
    await startStudy(body.study_id);
    return send(res, 202, { status: "started", study_id: body.study_id });
  }

  if (req.method === "GET" && parts[0] === "agent" && parts[2] === "stream") {
    const studyId = decodeURIComponent(parts[1]);
    const entry = studies.get(studyId) ?? (await startStudy(studyId));
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Replay buffered events so a late subscriber catches up.
    for (const evt of entry.buffer) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    entry.subscribers.add(res);
    req.on("close", () => entry.subscribers.delete(res));
    return;
  }

  if (req.method === "POST" && parts[0] === "agent" && parts[2] === "message") {
    const studyId = decodeURIComponent(parts[1]);
    const body = await readBody(req);
    const entry = studies.get(studyId);
    if (!entry?.sessionId) return send(res, 409, { error: "session_not_ready" });
    if (!body.text) return send(res, 400, { error: "text required" });
    await sdk.sendUserMessage(entry.sessionId, `[human guidance] ${body.text}`);
    emitter(studyId)({ kind: "human.guidance", study_id: studyId, text: body.text });
    return send(res, 202, { status: "queued" });
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(config.port, () => {
  console.info(`Labmate agent runtime listening on :${config.port}`);
});
