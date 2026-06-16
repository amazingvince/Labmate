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

  // Autonomous demo: auto-grant a compute approval when the requested cost is within
  // the study's budget, recorded as a real feedback(type=approval) so the launch
  // gate, ledger, and rubric all see a genuine approval. Set false to require a
  // human to approve in the cockpit. The gate itself is never bypassed.
  autoApprove: read("LABMATE_AUTO_APPROVE", { fallback: "true" }) === "true",

  // How long an auto-approval "waits" before being granted — a brief, visible
  // approval window (a human CAN approve in the cockpit during it) that never blocks
  // the run. Default 10s.
  approvalDelayMs: Number(read("LABMATE_APPROVAL_DELAY_MS", { fallback: "10000" })),

  // Labmate control plane (Cloudflare Worker) + internal token.
  controlPlaneUrl: () =>
    read("LABMATE_PUBLIC_URL", { fallback: "http://127.0.0.1:8787" }),
  internalToken: () => read("LABMATE_INTERNAL_TOKEN", { required: true }),

  // Modal runner endpoint (REAL experiment executor). Optional here: the runtime
  // launches experiments through the control plane (POST /api/experiments/launch),
  // and the Worker is what forwards the manifest to Modal with provenance + the
  // approval check. Only set this if you wire the optional direct-to-Modal path.
  modalRunnerUrl: () => read("MODAL_RUNNER_URL", { fallback: "" }),

  // This service.
  port: Number(read("AGENT_RUNTIME_PORT", { fallback: "8990" })),

  // Budgets / safety ceilings (defense in depth alongside per-study budget).
  maxToolCallsPerSession: Number(
    read("LABMATE_MAX_TOOL_CALLS", { fallback: "60" }),
  ),
  maxSessionSeconds: Number(read("LABMATE_MAX_SESSION_SECONDS", { fallback: "1800" })),

  // Fallback per-study compute budget used by the auto-approve gate ONLY when the
  // control plane does not return a study.budget (e.g. a study created before the
  // budget column existed). The real per-study budget from GET /api/studies/:id
  // always takes precedence. These mirror the Worker's defaults (worker.js
  // createStudy: max_trials 20, budget_seconds 600).
  defaultBudgetSeconds: Number(read("LABMATE_DEFAULT_BUDGET_SECONDS", { fallback: "600" })),
  defaultMaxTrials: Number(read("LABMATE_DEFAULT_MAX_TRIALS", { fallback: "20" })),

  // How long, after a session's loop terminates, the in-memory registry entry (its
  // event buffer + last id) is kept so late reconnects can replay the tail before it
  // is GC'd. Keep modest — the ledger in the control plane is the durable record.
  sessionGraceSeconds: Number(read("LABMATE_SESSION_GRACE_SECONDS", { fallback: "120" })),
};

/** Validate everything the runtime needs to actually run (not just bootstrap). */
export function assertRuntimeConfig() {
  config.anthropicApiKey();
  config.agentId();
  config.environmentId();
  config.internalToken();
  // modalRunnerUrl is optional — launches go through the control plane.
}
