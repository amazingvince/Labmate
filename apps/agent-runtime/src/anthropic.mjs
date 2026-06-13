/**
 * Thin wrapper over the Anthropic SDK's Managed Agents (beta) surface.
 *
 * Verified method names (managed-agents-2026-04-01), all under client.beta.*:
 *   agents:        create / retrieve / update / list / archive   (NO delete)
 *   environments:  create / retrieve / update / list / delete / archive
 *   sessions:      create / retrieve / update / list / delete / archive
 *   sessions.events: list / send / stream
 *   vaults:        create / retrieve / update / list / delete / archive
 *
 * The SDK adds the beta header automatically for these calls. We still pass an
 * explicit betas array where the SDK supports it, to be defensive.
 *
 * NOTE: pin the SDK version in package.json and confirm the exact shapes with
 * `npm ls @anthropic-ai/sdk` + the type defs before the demo — betas move.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.mjs";

const BETA = config.managedAgentsBeta;

let _client = null;
export function client() {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: config.anthropicApiKey() });
  return _client;
}

/* ---------- agents ---------- */

export async function createAgent(body) {
  // body: { name, model, system, tools, skills, mcp_servers, metadata }
  return client().beta.agents.create({ ...body, betas: [BETA] });
}

export async function listAgents() {
  return client().beta.agents.list({ betas: [BETA] });
}

export async function getAgent(agentId) {
  return client().beta.agents.retrieve(agentId, { betas: [BETA] });
}

/** Update an agent in place — creates a new immutable version, same id. Sessions
 *  started after this pick up the latest version automatically. */
export async function updateAgent(agentId, body) {
  return client().beta.agents.update(agentId, { ...body, betas: [BETA] });
}

/* ---------- environments ---------- */

export async function createEnvironment(body) {
  // body: { name, description?, config: { type: "cloud", networking, packages? } }
  return client().beta.environments.create({ ...body, betas: [BETA] });
}

/* ---------- sessions ---------- */

export async function createSession({ agentId, environmentId, title, resources, vaultIds, metadata }) {
  return client().beta.sessions.create({
    // string form uses the latest agent version; pass {type,id,version} to pin
    agent: agentId,
    environment_id: environmentId,
    ...(title ? { title } : {}),
    ...(resources ? { resources } : {}),
    ...(vaultIds ? { vault_ids: vaultIds } : {}),
    ...(metadata ? { metadata } : {}),
    betas: [BETA],
  });
}

export async function getSession(sessionId) {
  return client().beta.sessions.retrieve(sessionId, { betas: [BETA] });
}

/* ---------- events ---------- */

/** Send one or more events into a session (e.g. a user message or a tool result). */
export async function sendEvents(sessionId, events) {
  return client().beta.sessions.events.send(sessionId, { events, betas: [BETA] });
}

/** Convenience: a plain user text message. */
export async function sendUserMessage(sessionId, text) {
  return sendEvents(sessionId, [
    { type: "user.message", content: [{ type: "text", text }] },
  ]);
}

/** Convenience: return a custom tool result for a given tool-use id. */
export async function sendToolResult(sessionId, customToolUseId, content, isError = false) {
  return sendEvents(sessionId, [
    {
      type: "user.custom_tool_result",
      custom_tool_use_id: customToolUseId,
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      is_error: isError,
    },
  ]);
}

/**
 * Stream events from a session as an async iterable, reconnect/race-safe.
 *
 * The SSE stream has no replay and only delivers events emitted after it opens, so
 * a naive "send kickoff then open stream" (or a dropped connection) can miss early
 * events — e.g. the first agent.custom_tool_use, which strands the session in
 * requires_action forever. We use the documented consolidation pattern: open the
 * live stream, replay full history via events.list() to seed seen-ids (this covers
 * anything emitted before the stream opened, including the kickoff response), then
 * tail the live stream deduped by event id. Falls back to polling if stream() is
 * unavailable in the pinned SDK build.
 */
export async function* streamEvents(sessionId) {
  const c = client();
  if (c.beta.sessions.events.stream) {
    const stream = await c.beta.sessions.events.stream(sessionId, { betas: [BETA] });
    const seen = new Set();
    try {
      // events.list auto-paginates on iteration; history first, oldest→newest.
      for await (const past of c.beta.sessions.events.list(sessionId, { betas: [BETA] })) {
        if (past?.id) seen.add(past.id);
        yield past;
      }
    } catch {
      /* history replay is best-effort — tail the live stream regardless */
    }
    for await (const event of stream) {
      if (event?.id && seen.has(event.id)) continue;
      if (event?.id) seen.add(event.id);
      yield event;
    }
    return;
  }
  // Fallback: naive polling (use only if stream() isn't in this SDK build).
  let after;
  for (;;) {
    const page = await c.beta.sessions.events.list(sessionId, {
      betas: [BETA],
      ...(after ? { after } : {}),
    });
    for (const e of page.data ?? []) {
      after = e.id ?? after;
      yield e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
