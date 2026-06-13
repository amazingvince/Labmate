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
import { createAgent, createEnvironment, updateAgent, getAgent } from "./anthropic.mjs";
import { LABMATE_TOOLS } from "./tools.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envPath = join(repoRoot, ".env");
const force = process.argv.includes("--force");
const update = process.argv.includes("--update"); // update the existing agent in place

// Load .env into process.env. Tolerates both dotenv `KEY=value` and `KEY: value`
// (the repo's .env uses the colon form); the separator is the FIRST `=` or `:`, so
// values containing `:` (e.g. http://host:8787) parse correctly.
function loadEnv() {
  if (!existsSync(envPath)) return {};
  const map = {};
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    const i = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (i <= 0) continue;
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
- Review for leakage BEFORE any experiment. Record that review as a critique with
  kind="leakage" and led_to_decision="rerun", naming the post-outcome columns you
  will exclude. Treat post-outcome columns as banned unless a human explicitly
  approves them; never put a banned/leaky column in a script's features.
- Tune ONLY on the validation split. Never tune a threshold or hyperparameters on
  test. If you realize a run tuned on test, record a critique and rerun corrected.
- You AUTHOR a self-contained Python training script and submit it via
  launch_experiment. It runs in an isolated Modal Sandbox — the ONLY executor; no
  arbitrary code runs on your own host. The script reads the CSV at /work/data.csv,
  makes the deterministic split FIRST using the declared seed, trains, tunes on
  validation only (never test), evaluates on test once, and writes /work/result.json
  := {metrics, params, artifacts}. pandas/numpy/scikit-learn are installed; the
  sandbox has NO network. Exclude banned/leaky columns from the script's features.
  Ask for approval (request_approval) before spending compute.
- Propose at least 5 hypotheses across the study; link every run to a hypothesis.
- Record a critique for every result (leakage/test_set_tuning/metric/calibration/
  robustness). At the end, select the best run, record a calibration/metric critique
  linked to it (target_run_id = that run), and call record_decision with
  action="promote", promoted_run_id = that run, and a reason — this is the study's result.
- When the rubric is met, call write_report to produce a model card with a
  reproducible command and provenance, then stop.

Be concise in narration. Prefer calling tools over describing what you would do.
`.trim();

// The agent's tool surface: the Labmate custom tools (its real action surface) PLUS
// the built-in toolset with ONLY read/glob/grep enabled. Skills REQUIRE the `read`
// tool to be usable; bash/write/edit/code stay disabled so the agent still cannot
// run arbitrary training code — Modal is the only executor (Hard Rule 1).
const AGENT_TOOLS = [
  {
    type: "agent_toolset_20260401",
    default_config: { enabled: false },
    configs: [
      { name: "read", enabled: true },
      { name: "glob", enabled: true },
      { name: "grep", enabled: true },
    ],
  },
  ...LABMATE_TOOLS.map((t) => ({ type: "custom", ...t })),
];

async function main() {
  loadEnv();
  config.anthropicApiKey(); // fail fast if missing

  const existingAgent = process.env.LABMATE_AGENT_ID;
  const existingEnv = process.env.LABMATE_ENVIRONMENT_ID;
  if (existingAgent && existingEnv && !force && !update) {
    console.info("Already bootstrapped:");
    console.info(`  LABMATE_AGENT_ID=${existingAgent}`);
    console.info(`  LABMATE_ENVIRONMENT_ID=${existingEnv}`);
    console.info("Pass --force to create fresh resources (old ones are NOT deleted).");
    return;
  }

  // The Labmate DS skills (tabular-ds-protocol, leakage-review, optuna-search,
  // model-card) are CUSTOM skills uploaded to the workspace via the Skills API; pass
  // their ids in LABMATE_SKILL_IDS (comma-separated skill_* ids) and they attach
  // here. When absent we attach none — DS_SYSTEM_PROMPT already inlines the core
  // methodology — rather than the irrelevant `xlsx` Excel skill. Do NOT attach a
  // wrong skill: the agent is permanent (archive-only).
  const skills = (process.env.LABMATE_SKILL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill_id) => ({ type: "custom", skill_id, version: "latest" }));

  const agentBody = {
    name: "Labmate DS",
    model: config.model, // claude-opus-4-8
    system: DS_SYSTEM_PROMPT,
    tools: AGENT_TOOLS,
    ...(skills.length ? { skills } : {}),
    metadata: { project: "labmate" },
  };

  // --update: revise the EXISTING agent in place (new immutable version, same id).
  // Sessions started afterwards pick up the latest version — no env/secret change.
  if (update && existingAgent) {
    const cur = await getAgent(existingAgent); // version is a required optimistic lock
    console.info(`Updating agent ${existingAgent} (from version ${cur.version}; read-only toolset + ${skills.length} skills)...`);
    const updated = await updateAgent(existingAgent, { ...agentBody, version: cur.version });
    console.info(`  agent.id = ${updated.id} (new version ${updated.version ?? "?"})`);
    console.info("\nAgent updated ✅ New sessions use the latest version. Environment unchanged.");
    return;
  }

  console.info(
    `Creating Labmate agent (model + DS system prompt + ${LABMATE_TOOLS.length} custom tools + read-only toolset + ${skills.length} skills)...`,
  );
  const agent = await createAgent(agentBody);
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
