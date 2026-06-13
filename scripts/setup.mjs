#!/usr/bin/env node
/**
 * setup.mjs — the single entry point you run after unzipping.
 *
 *   npm run setup
 *
 * It is idempotent and safe to re-run. It will:
 *   1. Ensure .env exists (copy from .env.example if not) and report which
 *      REQUIRED keys are still blank — without printing their values.
 *   2. Install JS dependencies (root) unless --skip-install is passed.
 *   3. Generate the deterministic demo dataset if it is missing.
 *   4. Run the schema-check static guardrail.
 *   5. Print exactly what to do next (preflight, then open Claude Code).
 *
 * It deliberately does NOT touch Modal or Cloudflare — those need your keys and
 * are driven from docs/KICKOFF.md inside Claude Code. This script only gets the
 * local scaffold into a known-green state.
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipInstall = args.has("--skip-install");

const REQUIRED_KEYS = [
  "ANTHROPIC_API_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "LABMATE_INTERNAL_TOKEN",
];

const step = (n, msg) => console.info(`\n[${n}/5] ${msg}`);
const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: root, stdio: "inherit", ...opts });

console.info("Labmate setup");
console.info("=============");

// 1. .env ----------------------------------------------------------------------
step(1, "Checking .env");
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");
if (!existsSync(envPath)) {
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    console.info("  Created .env from .env.example.");
  } else {
    console.error("  .env.example is missing — cannot create .env.");
    process.exit(1);
  }
} else {
  console.info("  .env already exists (leaving it untouched).");
}
// Report blank required keys without revealing any values.
const envText = readFileSync(envPath, "utf8");
const envMap = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => l && !l.trimStart().startsWith("#") && l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);
const blank = REQUIRED_KEYS.filter((k) => !envMap[k]);
if (blank.length) {
  console.info(`  ⚠️  ${blank.length} required key(s) still blank:`);
  for (const k of blank) console.info(`        - ${k}`);
  console.info("     Fill them in .env (see docs/ENV.md). Setup will continue.");
} else {
  console.info("  ✅ all required keys are present.");
}

// 2. install -------------------------------------------------------------------
step(2, "Installing JS dependencies");
if (skipInstall) {
  console.info("  --skip-install passed; skipping npm install.");
} else {
  try {
    run("npm install --no-audit --no-fund");
  } catch {
    console.info(
      "  ⚠️  npm install hit an error (often network at venues). You can retry\n" +
        "     later with `npm install`; the rest of setup will continue.",
    );
  }
}

// 3. dataset -------------------------------------------------------------------
step(3, "Ensuring the demo dataset exists");
const dataPath = join(root, "examples/sla_tickets/data.csv");
if (existsSync(dataPath)) {
  console.info("  examples/sla_tickets/data.csv already present.");
} else {
  try {
    run("python3 scripts/gen_dataset.py");
  } catch {
    console.info(
      "  ⚠️  Could not generate the dataset (is python3 installed?).\n" +
        "     Run `python3 scripts/gen_dataset.py` once Python is available.",
    );
  }
}

// 4. schema check --------------------------------------------------------------
step(4, "Running schema-check guardrail");
let schemaGreen = true;
try {
  run("node scripts/schema-check.mjs");
} catch {
  schemaGreen = false;
  console.info("  ⚠️  schema-check reported problems (see above).");
}

// 5. next steps ----------------------------------------------------------------
step(5, "Next steps");
console.info(
  [
    "",
    "  1. Finish filling in .env       (docs/ENV.md explains every key)",
    "  2. Validate tooling + keys:     ./scripts/preflight.sh",
    "  3. Open Claude Code in this folder and paste:  docs/KICKOFF.md",
    "     (it contains the /goal that drives the whole study end to end)",
    "",
    schemaGreen
      ? "  Local scaffold is green. ✅"
      : "  Fix the schema-check items above, then re-run `npm run setup`.",
    "",
  ].join("\n"),
);
process.exit(schemaGreen ? 0 : 1);
