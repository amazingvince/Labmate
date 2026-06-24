/**
 * Unit tests for the dependency-light CSV profiler in apps/web/src/profiles.js.
 *
 * Pure (no wrangler / miniflare): exercises parseCsv + profileCsv directly so the
 * profiling heuristic is covered even where the Worker harness can't boot. The
 * worker-level upload + generic-grading behaviour is covered by
 * tests/datasets.api.test.mjs (which needs wrangler dev).
 *
 * Run on its own:  node --test tests/profiling.unit.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  profileCsv,
  parseCsv,
  SLA_TICKETS_PROFILE,
  generatedHypothesisLibrary,
} from "../apps/web/src/profiles.js";

// A churn-style table with an OBVIOUS name-pattern leakage column
// (`account_closed_date`) and a name-innocent column that PERFECTLY separates the
// target (`refund_issued` — issued iff churned). The other columns (plan, region,
// is_active, monthly_spend) are intentionally NOISY w.r.t. churn so they do NOT
// trivially separate, keeping the test about the two real leakage signals.
// Generated deterministically so the separation heuristic has enough rows.
function bigChurn() {
  const header =
    "customer_id,signup_date,plan,monthly_spend,region,is_active,account_closed_date,refund_issued,churned";
  const plans = ["basic", "pro", "enterprise"];
  const regions = ["us", "emea", "apac"];
  const rows = [header];
  for (let i = 0; i < 60; i++) {
    const churned = i % 3 === 0 ? 1 : 0; // ~1/3 churn
    const day = String((i % 28) + 1).padStart(2, "0");
    const signup = `2024-01-${day}`;
    // plan/region are deliberately decoupled from the churn cycle (different moduli)
    // so neither perfectly separates the target — only the true leakage does.
    const plan = plans[i % 7 % 3];
    const region = i % 11 === 0 ? "" : regions[(i % 5) % 3]; // some missing region
    const spend = (10 + (i % 5) * 10).toFixed(2);
    // is_active is noisy: half the churned rows are still flagged active, and some
    // retained rows are inactive — so it does NOT perfectly predict churn.
    const active = i % 2 === 0 ? "yes" : "no";
    // post-outcome fields: only set when churned (the leakage).
    const closed = churned ? `2024-06-${day}` : "";
    const refund = churned ? "yes" : "no";
    rows.push(`C${i},${signup},${plan},${spend},${region},${active},${closed},${refund},${churned}`);
  }
  return rows.join("\n");
}

test("parseCsv: handles quoted fields with embedded commas", () => {
  const rows = parseCsv('a,b,c\n1,"x, y",3\n4,"he said ""hi""",6\n');
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.deepEqual(rows[1], ["1", "x, y", "3"]);
  assert.deepEqual(rows[2], ["4", 'he said "hi"', "6"]);
});

test("profileCsv: infers dtypes per column", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  const byName = Object.fromEntries(p.columns.map((c) => [c.name, c]));
  assert.equal(byName.monthly_spend.dtype, "numeric");
  assert.equal(byName.signup_date.dtype, "datetime");
  assert.equal(byName.plan.dtype, "categorical");
  assert.equal(byName.is_active.dtype, "boolean");
  assert.equal(byName.region.dtype, "categorical");
  // churned is 0/1 numeric (the target column itself)
  assert.equal(byName.churned.dtype, "numeric");
});

test("profileCsv: flags the name-pattern leakage column", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  assert.ok(p.leakage_candidates.includes("account_closed_date"), "account_closed_date should be flagged");
  const col = p.columns.find((c) => c.name === "account_closed_date");
  assert.equal(col.is_candidate_leakage, true);
  assert.ok(col.leakage_reason, "leakage column carries a reason");
});

test("profileCsv: flags a name-innocent column that separates the target", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  // refund_issued is perfectly correlated with churned but has an innocent name.
  assert.ok(p.leakage_candidates.includes("refund_issued"), "near-perfect separation should be flagged");
});

test("profileCsv: does NOT flag a creation timestamp as leakage", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  assert.ok(!p.leakage_candidates.includes("signup_date"), "signup_date is a creation time, not leakage");
});

test("profileCsv: picks a time-based split when a creation timestamp exists", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  assert.equal(p.split.strategy, "time_based");
  assert.equal(p.split.time_col, "signup_date");
  assert.equal(p.split.seed, 42);
});

test("profileCsv: falls back to random split with no datetime column", () => {
  const csv = "a,b,target\n1,x,0\n2,y,1\n3,x,0\n4,y,1\n";
  const p = profileCsv(csv, { target: "target", datasetId: "no_time" });
  assert.equal(p.split.strategy, "random");
  assert.equal(p.split.seed, 42);
});

test("profileCsv: reports missingness, cardinality, and example values", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  const region = p.columns.find((c) => c.name === "region");
  assert.ok(region.missing_fraction > 0, "region has missing values");
  assert.ok(region.cardinality >= 3);
  assert.ok(Array.isArray(region.example_values) && region.example_values.length > 0);
});

test("profileCsv: row_count + suggested categoricals", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  assert.equal(p.row_count, 60);
  assert.ok(p.categorical_features.includes("plan"));
  assert.ok(p.datetime_columns.includes("signup_date"));
});

test("profileCsv: safe features exclude the target and leakage columns", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  assert.ok(!p.safe_features.includes("churned"));
  assert.ok(!p.safe_features.includes("account_closed_date"));
  assert.ok(p.safe_features.includes("plan"));
});

// ---------------------------------------------------------------------------
// generatedHypothesisLibrary — dataset-agnostic, baseline-first proposal
// ---------------------------------------------------------------------------

test("generatedHypothesisLibrary (classification): baseline-first, safe-feature-only cards", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  const cards = generatedHypothesisLibrary(p, {
    taskType: "binary_classification",
    target: "churned",
    metric: "recall",
    bannedColumns: [],
  });

  // >= 4 cards (baseline + 3 family/calibration cards)
  assert.ok(cards.length >= 4, `expected >=4 cards, got ${cards.length}`);

  // First card is the baseline using safe features only.
  const first = cards[0];
  assert.ok((first.tags || []).includes("baseline"), "first card tagged baseline");
  assert.equal(first.model_family, "logistic_regression");
  assert.ok(/baseline/i.test(first.statement));
  assert.ok(first.features.length > 0 && first.features.includes("plan"));

  // No card names a leakage / banned column or the target.
  for (const c of cards) {
    for (const leak of p.leakage_candidates) {
      assert.ok(!c.features.includes(leak), `${leak} must not appear in a card`);
    }
    assert.ok(!c.features.includes("churned"), "target never a feature");
    // every card references the study's target or metric in its text
    assert.ok(/churned|recall/.test(c.statement), "card references the target or metric");
  }

  // Families match the classification task type (+ a calibration card).
  const families = cards.map((c) => c.model_family);
  assert.ok(families.includes("logistic_regression"));
  assert.ok(families.includes("random_forest"));
  assert.ok(families.includes("hist_gradient_boosting"));
  assert.ok(cards.some((c) => (c.tags || []).includes("calibration")), "a calibration card exists");
});

test("generatedHypothesisLibrary (regression): linear baseline + tree families", () => {
  const csv =
    "id,created_at,x,price\n" +
    Array.from({ length: 40 }, (_, i) => `R${i},2024-01-01,${i % 5},${(i * 13.7).toFixed(2)}`).join("\n");
  const p = profileCsv(csv, { target: "price", datasetId: "houses" });
  const cards = generatedHypothesisLibrary(p, {
    taskType: "regression",
    target: "price",
    metric: "rmse",
  });
  assert.ok(cards.length >= 3, "regression proposes at least 3 cards");
  assert.ok((cards[0].tags || []).includes("baseline"));
  assert.equal(cards[0].model_family, "linear_regression", "regression baseline is linear");
  const families = cards.map((c) => c.model_family);
  assert.ok(families.includes("random_forest"));
  assert.ok(families.includes("hist_gradient_boosting"));
  // no classification-only calibration card in a regression proposal
  assert.ok(!cards.some((c) => (c.tags || []).includes("calibration")));
  for (const c of cards) assert.ok(/price/.test(c.statement));
});

test("generatedHypothesisLibrary respects an explicit banned column", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  // plan is a normally-safe feature; ban it explicitly and confirm it disappears.
  const cards = generatedHypothesisLibrary(p, {
    taskType: "binary_classification",
    target: "churned",
    metric: "recall",
    bannedColumns: ["plan"],
  });
  for (const c of cards) assert.ok(!c.features.includes("plan"), "explicitly banned column excluded");
});

test("generatedHypothesisLibrary is deterministic", () => {
  const p = profileCsv(bigChurn(), { target: "churned", datasetId: "churn" });
  const opts = { taskType: "binary_classification", target: "churned", metric: "recall" };
  assert.deepEqual(generatedHypothesisLibrary(p, opts), generatedHypothesisLibrary(p, opts));
});

// Profiling the bundled sla_tickets CSV must stay equivalent to the committed golden
// profile: same target leakage set, time-based split on created_at.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("profileCsv on bundled sla_tickets matches the golden contract", () => {
  const csv = readFileSync(join(root, "examples/sla_tickets/data.csv"), "utf8");
  const p = profileCsv(csv, { target: "breached_sla", datasetId: "sla_tickets" });
  // All four planted leakage columns flagged by name patterns.
  for (const col of SLA_TICKETS_PROFILE.leakage_candidates) {
    assert.ok(p.leakage_candidates.includes(col), `expected ${col} flagged as leakage`);
  }
  // created_at recognized and chosen as the time split anchor.
  assert.equal(p.split.strategy, "time_based");
  assert.equal(p.split.time_col, "created_at");
  // ticket_id is high-cardinality text/id, not a safe modeling feature we'd rely on,
  // but the documented safe features must all be present and NOT flagged as leakage.
  for (const col of SLA_TICKETS_PROFILE.safe_features) {
    assert.ok(!p.leakage_candidates.includes(col), `${col} must not be leakage`);
  }
});
