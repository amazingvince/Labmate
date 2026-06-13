#!/usr/bin/env node
/**
 * schema-check.mjs — static guardrail for Labmate's contracts.
 *
 * Runs with zero external deps (uses Node's built-ins) so it works the instant
 * you clone, before `npm install`. It checks three things:
 *
 *   1. Every *.schema.json in packages/schemas parses and is a valid-looking
 *      JSON Schema (has $schema, $id, and a type or $defs).
 *   2. docs/rubric.json parses, has the structure grade_study.py expects, and
 *      every check has an id + description + `required` boolean + `check`.
 *   3. Cross-file consistency: the rubric's references to files that must exist
 *      (workflows/run-study.js, .claude/agents, .claude/skills) actually exist,
 *      and the example study's brief/rubric are present.
 *
 * Exit non-zero on any failure so `npm run guard` and CI/hooks can gate on it.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let errors = 0;
let checks = 0;

const fail = (msg) => {
  console.error(`  ❌ ${msg}`);
  errors++;
};
const ok = (msg) => {
  console.info(`  ✅ ${msg}`);
  checks++;
};

function readJson(relPath) {
  const abs = join(root, relPath);
  const text = readFileSync(abs, "utf8");
  return JSON.parse(text);
}

console.info("\nSchema check");
console.info("============");

// 1. JSON Schemas --------------------------------------------------------------
console.info("JSON schemas (packages/schemas):");
const schemaDir = join(root, "packages/schemas");
if (!existsSync(schemaDir)) {
  fail("packages/schemas directory is missing");
} else {
  const schemaFiles = readdirSync(schemaDir).filter((f) =>
    f.endsWith(".schema.json"),
  );
  if (schemaFiles.length === 0) fail("no *.schema.json files found");
  for (const f of schemaFiles) {
    try {
      const s = readJson(join("packages/schemas", f));
      const hasShape =
        typeof s === "object" &&
        s !== null &&
        (s.type !== undefined || s.$defs !== undefined);
      const hasMeta = s.$schema !== undefined && s.$id !== undefined;
      if (hasShape && hasMeta) ok(`${f} parses and looks like JSON Schema`);
      else fail(`${f} is missing $schema/$id or type/$defs`);
    } catch (e) {
      fail(`${f} failed to parse: ${e.message}`);
    }
  }
}

// 2. Rubric --------------------------------------------------------------------
console.info("Rubric (docs/rubric.json):");
let rubric;
try {
  rubric = readJson("docs/rubric.json");
  ok("docs/rubric.json parses");
} catch (e) {
  fail(`docs/rubric.json failed to parse: ${e.message}`);
}
if (rubric) {
  if (!rubric.name) fail("rubric missing `name`");
  if (rubric.version === undefined) fail("rubric missing `version`");
  if (!Array.isArray(rubric.categories) || rubric.categories.length === 0) {
    fail("rubric missing `categories` array");
  } else {
    ok(`rubric has ${rubric.categories.length} categories`);
    let totalChecks = 0;
    let requiredChecks = 0;
    const seenIds = new Set();
    for (const cat of rubric.categories) {
      if (!cat.id || !cat.title) fail(`category missing id/title: ${JSON.stringify(cat).slice(0, 60)}`);
      if (!Array.isArray(cat.checks)) {
        fail(`category ${cat.id} has no checks array`);
        continue;
      }
      for (const c of cat.checks) {
        totalChecks++;
        if (!c.id) fail(`a check in ${cat.id} is missing an id`);
        else if (seenIds.has(c.id)) fail(`duplicate check id: ${c.id}`);
        else seenIds.add(c.id);
        if (!c.description) fail(`check ${c.id} missing description`);
        if (typeof c.required !== "boolean") fail(`check ${c.id} missing boolean \`required\``);
        if (!c.check) fail(`check ${c.id} missing \`check\` expression`);
        if (c.required) requiredChecks++;
      }
    }
    ok(`rubric has ${totalChecks} checks (${requiredChecks} required)`);
    // The signature "caught_an_issue" check is the demo's whole story — guard it.
    if (seenIds.has("caught_an_issue")) ok("rubric includes `caught_an_issue`");
    else fail("rubric is missing the `caught_an_issue` check (core to the demo)");
  }
}

// 3. Cross-file consistency ----------------------------------------------------
console.info("Cross-file consistency:");
const mustExist = [
  ".claude/workflows/run-study.js",
  ".claude/agents",
  ".claude/skills",
  ".claude/settings.json",
  "CLAUDE.md",
  "docs/BRIEF.md",
  "docs/data_contract.md",
  "docs/metric_contract.md",
  "examples/sla_tickets/brief.md",
  "examples/sla_tickets/rubric.md",
  "apps/web/schema.sql",
  "apps/modal-runner/runner.py",
  "apps/mcp-server/src/index.js",
];
for (const rel of mustExist) {
  const abs = join(root, rel);
  if (existsSync(abs)) {
    const kind = statSync(abs).isDirectory() ? "dir" : "file";
    ok(`${rel} (${kind})`);
  } else {
    fail(`${rel} is referenced by the harness but does not exist`);
  }
}

// Verify there is at least one agent and one skill, since the rubric requires them.
const agentsDir = join(root, ".claude/agents");
if (existsSync(agentsDir)) {
  const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  if (agents.length >= 1) ok(`${agents.length} subagent(s) defined`);
  else fail("no subagents found in .claude/agents");
}
const skillsDir = join(root, ".claude/skills");
if (existsSync(skillsDir)) {
  const skills = readdirSync(skillsDir).filter((d) =>
    existsSync(join(skillsDir, d, "SKILL.md")),
  );
  if (skills.length >= 1) ok(`${skills.length} skill(s) with SKILL.md`);
  else fail("no skills with SKILL.md found in .claude/skills");
}

// Summary ----------------------------------------------------------------------
console.info("============");
console.info(`Checks passed: ${checks}   Failures: ${errors}`);
if (errors > 0) {
  console.error("Schema check FAILED. Fix the ❌ items above.\n");
  process.exit(1);
}
console.info("Schema check green.\n");
