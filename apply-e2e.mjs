#!/usr/bin/env node
/**
 * apply-e2e.mjs — safely add the E2E (Managed Agents) changes to shared files in
 * an EXISTING Labmate repo, without clobbering your work.
 *
 * Run from your repo root AFTER extracting the overlay here:
 *   node apply-e2e.mjs
 *
 * It is idempotent and defensive:
 *   - it SKIPS any change already present (safe to run twice),
 *   - if it can't find a safe anchor in one of your files (because yours has
 *     diverged), it does NOT guess — it prints the exact manual edit instead.
 *
 * It touches only four files:
 *   package.json            — workspace entry + 4 scripts + guard
 *   .env.example            — the agent-runtime env block
 *   scripts/schema-check.mjs — new paths in the mustExist list (if you use it)
 *   apps/api-spec/openapi.yaml — two new routes (if you have the spec)
 *
 * The 13 NEW files in this overlay were already dropped into place by extraction;
 * this script does not touch them.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const todo = []; // manual instructions we couldn't safely automate
let changed = 0;
let skipped = 0;

const note = (m) => console.info(`  • ${m}`);
const did = (m) => {
  console.info(`  ✅ ${m}`);
  changed++;
};
const skip = (m) => {
  console.info(`  ⏭️  ${m}`);
  skipped++;
};
const manual = (file, instruction) => {
  todo.push({ file, instruction });
  console.info(`  ⚠️  ${file}: couldn't auto-apply — see manual step below`);
};

console.info("\nApplying Labmate E2E changes");
console.info("============================");

/* ---------- 1. package.json (JSON-safe, divergence-proof) ---------- */
console.info("package.json:");
if (!existsSync("package.json")) {
  manual("package.json", "No package.json at repo root — are you in the right directory?");
} else {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  let touched = false;

  pkg.workspaces = pkg.workspaces ?? [];
  if (!pkg.workspaces.includes("apps/agent-runtime")) {
    pkg.workspaces.push("apps/agent-runtime");
    touched = true;
    did('workspaces += "apps/agent-runtime"');
  } else skip('workspaces already has "apps/agent-runtime"');

  pkg.scripts = pkg.scripts ?? {};
  const wantScripts = {
    "agent:bootstrap": "node apps/agent-runtime/src/bootstrap.mjs",
    "agent:dev": "node apps/agent-runtime/src/server.mjs",
    "test:agent": "node --test apps/agent-runtime/tests/*.test.mjs",
    "demo:e2e": "node scripts/demo_e2e.mjs",
  };
  for (const [k, v] of Object.entries(wantScripts)) {
    if (!pkg.scripts[k]) {
      pkg.scripts[k] = v;
      touched = true;
      did(`scripts.${k}`);
    } else skip(`scripts.${k} already present`);
  }

  // Fold test:agent into guard if guard exists and doesn't already run it.
  if (pkg.scripts.guard && !pkg.scripts.guard.includes("test:agent")) {
    pkg.scripts.guard = `${pkg.scripts.guard} && npm run test:agent`;
    touched = true;
    did("guard now runs test:agent");
  } else if (pkg.scripts.guard) skip("guard already runs test:agent");
  else note("no `guard` script found — skipping (optional)");

  if (touched) writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
}

/* ---------- 2. .env.example (append block if marker absent) ---------- */
console.info(".env.example:");
const ENV_BLOCK = `
# -----------------------------------------------------------------------------
# Agent runtime (apps/agent-runtime) — the Managed Agents bridge.
# LABMATE_AGENT_ID / LABMATE_ENVIRONMENT_ID are written by \`node src/bootstrap.mjs\`
# (run once). Do not create these per study — agents can't be deleted, only archived.
# -----------------------------------------------------------------------------
LABMATE_AGENT_ID=
LABMATE_ENVIRONMENT_ID=
AGENT_RUNTIME_PORT=8990
# Research-preview "Outcomes" self-eval. Leave false unless you have preview access;
# the runtime falls back to POST /api/grade against docs/rubric.json.
MANAGED_AGENTS_OUTCOMES=false
# Safety ceilings for a session (defense in depth alongside per-study budget).
LABMATE_MAX_TOOL_CALLS=60
LABMATE_MAX_SESSION_SECONDS=1800
`;
if (!existsSync(".env.example")) {
  manual(".env.example", `Create it (or add) the following block:\n${ENV_BLOCK}`);
} else {
  const env = readFileSync(".env.example", "utf8");
  if (env.includes("LABMATE_AGENT_ID")) skip("agent-runtime block already present");
  else {
    writeFileSync(".env.example", env.replace(/\s*$/, "") + "\n" + ENV_BLOCK);
    did("appended agent-runtime env block");
  }
}

/* ---------- 3. scripts/schema-check.mjs (insert into mustExist) ---------- */
console.info("scripts/schema-check.mjs:");
const NEW_PATHS = `  "apps/api-spec/openapi.yaml",
  "apps/agent-runtime/src/server.mjs",
  "apps/agent-runtime/src/bootstrap.mjs",
  "apps/agent-runtime/src/loop.mjs",
  "apps/agent-runtime/tests/e2e.smoke.test.mjs",
  "docs/GOAL_E2E.md",
  "scripts/demo_e2e.mjs",
`;
if (!existsSync("scripts/schema-check.mjs")) {
  skip("no scripts/schema-check.mjs (you may not use it) — nothing to do");
} else {
  let sc = readFileSync("scripts/schema-check.mjs", "utf8");
  if (sc.includes('"apps/agent-runtime/src/server.mjs"')) {
    skip("agent-runtime paths already in mustExist");
  } else {
    const anchor = '  "apps/mcp-server/src/index.js",\n';
    if (sc.includes(anchor)) {
      sc = sc.replace(anchor, anchor + NEW_PATHS);
      writeFileSync("scripts/schema-check.mjs", sc);
      did("added agent-runtime paths to mustExist");
    } else {
      manual(
        "scripts/schema-check.mjs",
        `Add these lines inside the \`mustExist\` array:\n${NEW_PATHS}`,
      );
    }
  }
}

/* ---------- 4. apps/api-spec/openapi.yaml (insert 2 routes before components:) ---------- */
console.info("apps/api-spec/openapi.yaml:");
const ROUTES = `  /api/critiques:
    post:
      tags: [experiments]
      operationId: recordCritique
      summary: Record a critique + decision (record_critique)
      description: >
        Stores a methodological critique of a run and the decision it leads to. The
        agent runtime calls this during its review step; the cockpit renders it in
        the evidence ledger. This is how the self-correction moment is captured.
      security:
        - internalToken: []
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Critique" }
      responses:
        "201":
          description: Critique recorded.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Critique" }
        "401": { $ref: "#/components/responses/Unauthorized" }

  /api/studies/{studyId}/stream:
    parameters:
      - $ref: "#/components/parameters/StudyId"
    get:
      tags: [studies]
      operationId: streamStudyActivity
      summary: Live agent activity (SSE)
      description: >
        Server-Sent Events stream of the study's live agent activity (assistant
        narration, tool calls/results, approvals, done). The control plane proxies
        the agent runtime's stream so the cockpit has one origin. Public read for
        the cockpit; the runtime->control-plane push is authenticated separately.
        Each \`data:\` frame is a JSON object with a \`kind\` field.
      security: []
      responses:
        "200":
          description: An event stream (text/event-stream).
          content:
            text/event-stream:
              schema:
                type: string

`;
if (!existsSync("apps/api-spec/openapi.yaml")) {
  skip("no apps/api-spec/openapi.yaml (skip if you didn't add the spec)");
} else {
  let spec = readFileSync("apps/api-spec/openapi.yaml", "utf8");
  if (spec.includes("/api/critiques:")) {
    skip("/api/critiques + stream routes already present");
  } else {
    const anchor = "\ncomponents:\n";
    const idx = spec.indexOf(anchor);
    if (idx !== -1) {
      spec = spec.slice(0, idx) + "\n" + ROUTES + spec.slice(idx + 1);
      writeFileSync("apps/api-spec/openapi.yaml", spec);
      did("inserted /api/critiques and /api/studies/{studyId}/stream");
    } else {
      manual(
        "apps/api-spec/openapi.yaml",
        `Add these two paths under \`paths:\` (above \`components:\`):\n\n${ROUTES}`,
      );
    }
  }
}

/* ---------- summary ---------- */
console.info("\n============================");
console.info(`Applied: ${changed}   Skipped (already present): ${skipped}   Manual: ${todo.length}`);
if (todo.length) {
  console.info("\nManual steps needed (your files diverged — apply these by hand):");
  for (const { file, instruction } of todo) {
    console.info(`\n--- ${file} ---\n${instruction}`);
  }
}
console.info("\nNext:");
console.info("  npm install            # picks up apps/agent-runtime as a workspace");
console.info("  npm run test:agent     # should pass (4 tests)");
console.info("  npm run guard          # full guardrails");
console.info("  see docs/GOAL_E2E.md   # the goal to paste into Claude Code\n");
