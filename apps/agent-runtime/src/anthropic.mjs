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
 * Stream events from a session as an async iterable. Prefer the SDK's stream over
 * hand-rolled SSE. Falls back to polling list() if stream() is unavailable in the
 * pinned SDK version.
 */
export async function* streamEvents(sessionId) {
  const c = client();
  if (c.beta.sessions.events.stream) {
    const stream = await c.beta.sessions.events.stream(sessionId, { betas: [BETA] });
    for await (const event of stream) {
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
