/**
 * Runtime configuration. Loads from process.env (populate via the repo .env).
 * Fails fast with a clear message when a required key is missing — never invents
 * credentials.
 */

function read(name, { required = false, fallback = undefined } = {}) {
  const v = process.env[name] ?? fallback;
  if (required && (v === undefined || v === "")) {
    throw new Error(
      `Missing required env var ${name}. Set it in .env (see docs/ENV.md).`,
    );
  }
  return v;
}

export const config = {
  // Anthropic / Managed Agents
  anthropicApiKey: () => read("ANTHROPIC_API_KEY", { required: true }),
  model: read("ANTHROPIC_MODEL", { fallback: "claude-opus-4-8" }),
  // Beta header for Managed Agents. The SDK sets this automatically for
  // client.beta.{agents,environments,sessions,vaults}.* — kept here for clarity
  // and for any raw fetch fallback.
  managedAgentsBeta: "managed-agents-2026-04-01",

  // Persisted Managed Agents resources (written by bootstrap.mjs).
  agentId: () => read("LABMATE_AGENT_ID", { required: true }),
  environmentId: () => read("LABMATE_ENVIRONMENT_ID", { required: true }),

  // Optional research-preview feature; default OFF so we don't depend on access.
  outcomesEnabled: read("MANAGED_AGENTS_OUTCOMES", { fallback: "false" }) === "true",

  // Labmate control plane (Cloudflare Worker) + internal token.
  controlPlaneUrl: () =>
    read("LABMATE_PUBLIC_URL", { fallback: "http://127.0.0.1:8787" }),
  internalToken: () => read("LABMATE_INTERNAL_TOKEN", { required: true }),

  // Modal runner endpoint (REAL experiment executor).
  modalRunnerUrl: () => read("MODAL_RUNNER_URL", { required: true }),

  // This service.
  port: Number(read("AGENT_RUNTIME_PORT", { fallback: "8990" })),

  // Budgets / safety ceilings (defense in depth alongside per-study budget).
  maxToolCallsPerSession: Number(
    read("LABMATE_MAX_TOOL_CALLS", { fallback: "60" }),
  ),
  maxSessionSeconds: Number(read("LABMATE_MAX_SESSION_SECONDS", { fallback: "1800" })),
};

/** Validate everything the runtime needs to actually run (not just bootstrap). */
export function assertRuntimeConfig() {
  config.anthropicApiKey();
  config.agentId();
  config.environmentId();
  config.internalToken();
  config.modalRunnerUrl();
}
