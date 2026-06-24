/**
 * Unit tests for the PER-STUDY contract generator in apps/web/src/contracts.js.
 *
 * Pure (no wrangler / miniflare): feeds buildContracts a study + a real profileCsv
 * profile and asserts the generated data + metric contracts. Covers:
 *   1. an UPLOADED synthetic churn CSV (with a *_closed_date leakage column) — the
 *      data contract names the target, bans the leakage candidate, picks safe features,
 *      and sets a split; the metric contract carries the primary metric + guardrail;
 *   2. the bundled sla_tickets golden profile — the generated contract is equivalent
 *      to docs/data_contract.md essentials (target, 4 leakage cols banned, time-based
 *      split on created_at, seed 42) and the metric contract carries recall + the FPR
 *      guardrail.
 *
 * Run on its own:  node --test tests/contracts.unit.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { profileCsv, SLA_TICKETS_PROFILE } from "../apps/web/src/profiles.js";
import {
  buildContracts,
  buildDataContract,
  buildMetricContract,
  inferTaskType,
} from "../apps/web/src/contracts.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// A churn table with a name-pattern leakage column (account_closed_date) and a
// name-innocent perfect separator (refund_issued). Deterministic.
function churnCsv() {
  const header =
    "customer_id,signup_date,plan,monthly_spend,region,account_closed_date,refund_issued,churned";
  const plans = ["basic", "pro", "enterprise"];
  const regions = ["us", "emea", "apac"];
  const rows = [header];
  for (let i = 0; i < 60; i++) {
    const churned = i % 3 === 0 ? 1 : 0;
    const day = String((i % 28) + 1).padStart(2, "0");
    const plan = plans[(i % 7) % 3];
    const region = i % 11 === 0 ? "" : regions[(i % 5) % 3];
    const spend = (10 + (i % 5) * 10).toFixed(2);
    const closed = churned ? `2024-06-${day}` : "";
    const refund = churned ? "yes" : "no";
    rows.push(`C${i},2024-01-${day},${plan},${spend},${region},${closed},${refund},${churned}`);
  }
  return rows.join("\n");
}

test("data contract for an uploaded churn CSV: target, banned leakage, safe features, split", () => {
  const profile = profileCsv(churnCsv(), { target: "churned", datasetId: "churn" });
  const study = {
    id: "study_x",
    dataset_id: "churn",
    target: "churned",
    metric: "recall",
    metric_rationale: "Catching churners is worth some false alarms.",
  };
  const constraints = {
    primary_metric: "recall",
    guardrails: ["false_positive_rate <= 0.20"],
    banned_columns: [],
  };
  const dc = buildDataContract(study, profile, constraints);

  assert.equal(dc.target, "churned");
  // the leakage candidate is listed AND banned (default-ban policy)
  const leakNames = dc.leakage_candidates.map((l) => l.column);
  assert.ok(leakNames.includes("account_closed_date"), "account_closed_date is a leakage candidate");
  assert.ok(dc.banned_columns.includes("account_closed_date"), "leakage column banned");
  assert.ok(dc.banned_columns.includes("refund_issued"), "name-innocent separator banned too");
  // leakage entries carry a reason
  const closed = dc.leakage_candidates.find((l) => l.column === "account_closed_date");
  assert.ok(closed && closed.reason, "leakage candidate carries a reason");
  // safe features exclude target + leakage, include a real feature
  assert.ok(dc.safe_features.includes("plan"), "plan is a safe feature");
  assert.ok(!dc.safe_features.includes("churned"), "target excluded from safe features");
  assert.ok(!dc.safe_features.includes("account_closed_date"), "leakage excluded from safe features");
  // dtype buckets
  assert.ok(dc.numeric.includes("monthly_spend"));
  assert.ok(dc.categoricals.includes("plan"));
  assert.ok(dc.datetime_columns.includes("signup_date"));
  // split: time-based on the creation timestamp, seeded
  assert.equal(dc.split_strategy.strategy, "time_based");
  assert.equal(dc.split_strategy.time_col, "signup_date");
  assert.equal(dc.split_strategy.seed, 42);
  // prediction-time assumption is stated
  assert.match(dc.prediction_time_assumption, /signup_date/);
  // missingness recorded for the missing region column
  assert.ok(dc.missingness.region > 0, "region missingness recorded");
});

test("metric contract for an uploaded churn CSV carries primary metric + guardrail", () => {
  const profile = profileCsv(churnCsv(), { target: "churned", datasetId: "churn" });
  const study = {
    id: "study_x",
    dataset_id: "churn",
    target: "churned",
    metric: "recall",
    metric_rationale: "Catching churners is worth some false alarms.",
  };
  const constraints = { primary_metric: "recall", guardrails: ["false_positive_rate <= 0.20"] };
  const mc = buildMetricContract(study, profile, constraints);

  assert.equal(mc.primary_metric, "recall");
  assert.ok(mc.rationale && mc.rationale.length > 0, "rationale present");
  assert.ok(
    mc.guardrails.some((g) => /false_positive_rate <= 0\.20/.test(g)),
    "FPR guardrail present",
  );
  assert.equal(mc.task_type, "binary_classification");
  assert.ok(Array.isArray(mc.secondary_metrics) && mc.secondary_metrics.includes("pr_auc"));
});

test("task type: numeric many-valued target ⇒ regression", () => {
  const csv = "id,created_at,x,price\n" +
    Array.from({ length: 40 }, (_, i) => `R${i},2024-01-01,${i % 5},${(i * 13.7).toFixed(2)}`).join("\n");
  const profile = profileCsv(csv, { target: "price", datasetId: "houses" });
  const study = { id: "s", dataset_id: "houses", target: "price", metric: "rmse" };
  assert.equal(inferTaskType(study, profile), "regression");
  const mc = buildMetricContract(study, profile, {});
  assert.equal(mc.primary_metric, "rmse");
  assert.ok(mc.secondary_metrics.includes("r2"));
  assert.equal(mc.threshold_tuned_on, null);
});

test("golden path: sla_tickets generated contract is equivalent to docs/data_contract.md essentials", () => {
  // Use the bundled golden profile (same one resolveProfile returns offline).
  const profile = SLA_TICKETS_PROFILE;
  const study = {
    id: "study_sla",
    dataset_id: "sla_tickets",
    target: "breached_sla",
    metric: "recall_at_fpr",
    metric_rationale: "Missing a breach is the expensive error.",
    constraints: {},
  };
  const constraints = {
    primary_metric: "recall",
    guardrails: ["false_positive_rate <= 0.20"],
    banned_columns: [],
  };
  const { data, metric } = buildContracts(study, profile, constraints);

  // target
  assert.equal(data.target, "breached_sla");
  // the 4 documented leakage candidates are all banned
  const leakNames = data.leakage_candidates.map((l) => l.column);
  for (const col of ["resolved_at", "time_to_resolution", "closed_status", "agent_notes_final"]) {
    assert.ok(leakNames.includes(col), `${col} flagged as leakage`);
    assert.ok(data.banned_columns.includes(col), `${col} banned`);
  }
  // time-based split on created_at, seed 42
  assert.equal(data.split_strategy.strategy, "time_based");
  assert.equal(data.split_strategy.time_col, "created_at");
  assert.equal(data.split_strategy.seed, 42);
  // documented safe features present, none flagged as leakage
  for (const col of SLA_TICKETS_PROFILE.safe_features) {
    assert.ok(data.safe_features.includes(col), `${col} is a safe feature`);
    assert.ok(!data.banned_columns.includes(col), `${col} not banned`);
  }
  // metric contract: recall + FPR guardrail
  assert.equal(metric.primary_metric, "recall");
  assert.ok(metric.guardrails.some((g) => /false_positive_rate <= 0\.20/.test(g)));
});

test("buildContracts is deterministic (same input ⇒ identical output)", () => {
  const profile = profileCsv(churnCsv(), { target: "churned", datasetId: "churn" });
  const study = { id: "s", dataset_id: "churn", target: "churned", metric: "recall" };
  const constraints = { guardrails: ["false_positive_rate <= 0.15"] };
  const a = buildContracts(study, profile, constraints);
  const b = buildContracts(study, profile, constraints);
  assert.deepEqual(a, b);
});

// reference the import so an unused-import linter wouldn't complain (and prove the file loads)
test("module exports are present", () => {
  assert.equal(typeof buildContracts, "function");
  assert.ok(readFileSync(join(root, "apps/web/src/contracts.js"), "utf8").length > 0);
});
