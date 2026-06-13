/**
 * Bootstrap — create the ONE versioned agent + ONE cloud environment Labmate uses,
 * then write their IDs to .env (LABMATE_AGENT_ID, LABMATE_ENVIRONMENT_ID).
 *
 *   node src/bootstrap.mjs
 *
 * Idempotent-ish: if .env already has both IDs, it prints them and exits unless you
 * pass --force. We REUSE these across studies because agents cannot be deleted
 * (only archived, permanently) — creating-per-study would leak resources fast.
 *
 * Run this once after your ANTHROPIC_API_KEY is set. It needs network + a real key.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { createAgent, createEnvironment } from "./anthropic.mjs";
import { LABMATE_TOOLS } from "./tools.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envPath = join(repoRoot, ".env");
const force = process.argv.includes("--force");

// Load .env into process.env (minimal parser; the repo's real loader can replace this).
function loadEnv() {
  if (!existsSync(envPath)) return {};
  const map = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    map[k] = v;
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return map;
}

function upsertEnv(updates) {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${k}=${v}`);
    else text += `${text.endsWith("\n") || text === "" ? "" : "\n"}${k}=${v}\n`;
  }
  writeFileSync(envPath, text);
}

const DS_SYSTEM_PROMPT = `
You are Labmate, an autonomous data scientist for tabular business problems.
You work the loop: hypothesis -> experiment -> evidence -> decision.

Rules you always follow:
- Establish the semantic contract before modeling: confirm the target, the metric
  and why it fits the business objective, and the split strategy.
- Create a deterministic train/validation/test split BEFORE any feature work.
- Always train a dummy/baseline first and compare every model to it.
- Review for leakage before training: treat post-outcome columns as banned unless a
  human explicitly approves them. Never put a banned/leaky column in features.
- Tune ONLY on the validation split. Never tune a threshold or hyperparameters on
  test. If you realize a run tuned on test, record a critique and rerun corrected.
- You do NOT run arbitrary code. You call launch_experiment with a manifest; the
  Modal sandbox is the only executor. Ask for approval (request_approval) before
  spending compute.
- Record a critique for every result (leakage/test_set_tuning/metric/calibration/
  robustness) and the decision it leads to. Link every run to a hypothesis.
- When the rubric is met, call write_report to produce a model card with a
  reproducible command and provenance, then stop.

Be concise in narration. Prefer calling tools over describing what you would do.
`.trim();

async function main() {
  loadEnv();
  config.anthropicApiKey(); // fail fast if missing

  const existingAgent = process.env.LABMATE_AGENT_ID;
  const existingEnv = process.env.LABMATE_ENVIRONMENT_ID;
  if (existingAgent && existingEnv && !force) {
    console.info("Already bootstrapped:");
    console.info(`  LABMATE_AGENT_ID=${existingAgent}`);
    console.info(`  LABMATE_ENVIRONMENT_ID=${existingEnv}`);
    console.info("Pass --force to create fresh resources (old ones are NOT deleted).");
    return;
  }

  console.info("Creating Labmate agent (model + DS system prompt + custom tools + skills)...");
  const agent = await createAgent({
    name: "Labmate DS",
    model: config.model, // claude-opus-4-8
    system: DS_SYSTEM_PROMPT,
    tools: LABMATE_TOOLS,
    // Anthropic-managed DS skills. Confirm availability/skill_ids in the Skills doc;
    // custom Labmate skills can be uploaded and referenced by skill_id + version.
    skills: [
      { type: "anthropic", skill_id: "xlsx" },
      // { type: "custom", skill_id: "<tabular-ds-protocol id>", version: "1" },
    ],
    metadata: { project: "labmate" },
  });
  console.info(`  agent.id = ${agent.id}`);

  console.info("Creating cloud environment (the agent's sandbox)...");
  const environment = await createEnvironment({
    name: "labmate-cloud",
    description: "Sandbox for Labmate agent built-in tools (bash/files/code).",
    config: {
      type: "cloud",
      // Keep networking tight; the agent reaches Modal/control-plane via custom
      // tools handled by the runtime, not from inside the sandbox.
      networking: { type: "limited" },
    },
    metadata: { project: "labmate" },
  });
  console.info(`  environment.id = ${environment.id}`);

  upsertEnv({
    LABMATE_AGENT_ID: agent.id,
    LABMATE_ENVIRONMENT_ID: environment.id,
  });
  console.info("\nWrote LABMATE_AGENT_ID and LABMATE_ENVIRONMENT_ID to .env ✅");
  console.info("Next: start the runtime (node src/server.mjs) and create a study.");
}

main().catch((err) => {
  console.error("Bootstrap failed:", err?.message ?? err);
  if (err?.request_id) console.error("request_id:", err.request_id);
  process.exit(1);
});
