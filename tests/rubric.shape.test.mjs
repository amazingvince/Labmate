// Smoke test: the rubric is the contract grade_study.py evaluates against, so
// its shape must stay stable. These tests fail loudly if someone reshapes it.
// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rubric = JSON.parse(readFileSync(join(root, "docs/rubric.json"), "utf8"));

test("rubric has required top-level fields", () => {
  assert.ok(rubric.name, "rubric needs a name");
  assert.ok(rubric.version !== undefined, "rubric needs a version");
  assert.ok(Array.isArray(rubric.categories), "rubric needs categories[]");
});

test("every check is well-formed", () => {
  const ids = new Set();
  for (const cat of rubric.categories) {
    assert.ok(cat.id && cat.title, `category needs id+title: ${JSON.stringify(cat).slice(0, 40)}`);
    assert.ok(Array.isArray(cat.checks), `category ${cat.id} needs checks[]`);
    for (const c of cat.checks) {
      assert.ok(c.id, "check needs id");
      assert.ok(!ids.has(c.id), `duplicate check id: ${c.id}`);
      ids.add(c.id);
      assert.ok(c.description, `check ${c.id} needs description`);
      assert.equal(typeof c.required, "boolean", `check ${c.id} needs boolean required`);
      assert.ok(c.check, `check ${c.id} needs a check expression`);
    }
  }
});

test("the signature checks the demo depends on exist", () => {
  const ids = new Set();
  for (const cat of rubric.categories) for (const c of cat.checks) ids.add(c.id);
  for (const required of [
    "caught_an_issue",
    "leakage_review_before_training",
    "baseline_present",
    "provenance",
    "verifiable_without_human",
  ]) {
    assert.ok(ids.has(required), `rubric is missing the ${required} check`);
  }
});

test("the five expected categories are present", () => {
  const catIds = rubric.categories.map((c) => c.id);
  for (const id of ["functional", "ds_quality", "agent_native_tracking", "orchestration", "safety_control"]) {
    assert.ok(catIds.includes(id), `missing rubric category ${id}`);
  }
});
