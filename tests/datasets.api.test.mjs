/**
 * Integration test for dataset-agnostic Labmate (SLICE 1): CSV upload + real
 * profiling + generic grading. Boots the Worker with `wrangler dev` (miniflare: D1 +
 * R2 + DO), exactly like tests/contract.api.test.mjs, then:
 *
 *   1. uploads a small synthetic churn CSV (with an obvious leakage column) via
 *      POST /api/datasets and asserts the real profile (dtypes, leakage flag, split);
 *   2. creates a study on that uploaded dataset, profiles + grades it, and asserts the
 *      data_contract / target_metric_documented checks evaluate GENERICALLY — they pass
 *      with a complete config and fail when target/metric are missing.
 *
 * If wrangler/miniflare cannot boot in this environment, this whole suite is skipped
 * (the pure profiler is covered by tests/profiling.unit.test.mjs regardless).
 *
 * Run on its own:  node --test tests/datasets.api.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "dev-internal-token-0000000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let wrangler = null;
let BASE = "";
let wranglerLog = "";
let persistDir = "";
let booted = false;

async function startWrangler(port, persist) {
  const bin = join(root, "node_modules/.bin/wrangler");
  wrangler = spawn(
    bin,
    [
      "dev",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--persist-to", persist,
      "--var", `LABMATE_INTERNAL_TOKEN:${TOKEN}`,
      "--var", "AGENT_RUNTIME_URL:",
    ],
    {
      cwd: join(root, "apps/web"),
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  wrangler.stdout.on("data", (d) => (wranglerLog += d));
  wrangler.stderr.on("data", (d) => (wranglerLog += d));

  const deadline = Date.now() + 90_000;
  BASE = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    if (wrangler.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/api/studies`);
      if (res.ok) {
        await res.arrayBuffer();
        return true;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function call(method, path, { body, auth, contentType } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = contentType || "application/json";
  if (auth) headers["authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const post = (path, body, opts = {}) => call("POST", path, { body, auth: true, ...opts });
const get = (path) => call("GET", path, {});

// A churn table with an obvious name-pattern leakage column (account_closed_date)
// and a name-innocent perfect separator (refund_issued).
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

before(async () => {
  const wp = await freePort();
  persistDir = join(root, "apps/web", ".mf-datasets-test");
  rmSync(persistDir, { recursive: true, force: true });
  booted = await startWrangler(wp, persistDir);
  if (!booted) console.warn("wrangler dev did not boot; skipping dataset API tests.\n" + wranglerLog.slice(-1500));
});

after(async () => {
  if (wrangler && wrangler.exitCode === null) {
    wrangler.kill("SIGTERM");
    await sleep(300);
    if (wrangler.exitCode === null) wrangler.kill("SIGKILL");
  }
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

const ctx = {};

test("POST /api/datasets: raw text/csv upload returns a dataset_id + real profile", async (t) => {
  if (!booted) return t.skip();
  const r = await post("/api/datasets?dataset_id=churn_demo&target=churned", churnCsv(), {
    contentType: "text/csv",
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.dataset_id, "churn_demo");
  const p = r.json.profile;
  assert.ok(p && Array.isArray(p.columns) && p.columns.length === 8);

  const byName = Object.fromEntries(p.columns.map((c) => [c.name, c]));
  assert.equal(byName.monthly_spend.dtype, "numeric");
  assert.equal(byName.signup_date.dtype, "datetime");
  assert.equal(byName.plan.dtype, "categorical");

  // leakage: obvious name pattern + name-innocent perfect separator
  assert.ok(p.leakage_candidates.includes("account_closed_date"), "account_closed_date flagged");
  assert.ok(p.leakage_candidates.includes("refund_issued"), "refund_issued flagged (separation)");
  assert.ok(!p.leakage_candidates.includes("signup_date"), "creation timestamp not flagged");

  // split: time-based on the creation timestamp
  assert.equal(p.split.strategy, "time_based");
  assert.equal(p.split.time_col, "signup_date");
  ctx.datasetId = r.json.dataset_id;
});

test("POST /api/datasets: idempotent on the same dataset_id (JSON body)", async (t) => {
  if (!booted) return t.skip();
  const r = await post("/api/datasets", { dataset_id: "churn_demo", target: "churned", csv: churnCsv() });
  assert.equal(r.status, 201);
  assert.equal(r.json.dataset_id, "churn_demo");
});

test("POST /api/datasets: 401 without a token", async (t) => {
  if (!booted) return t.skip();
  const r = await call("POST", "/api/datasets?dataset_id=nope", {
    body: "a,b\n1,2\n",
    contentType: "text/csv",
    auth: false,
  });
  assert.equal(r.status, 401);
});

test("uploaded CSV is served back from /data/{id}.csv", async (t) => {
  if (!booted) return t.skip();
  const res = await fetch(`${BASE}/data/churn_demo.csv`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.startsWith("customer_id,signup_date"));
});

test("study on an uploaded dataset profiles for real (not the sla_tickets profile)", async (t) => {
  if (!booted) return t.skip();
  let r = await post("/api/studies", {
    brief: "Predict churn for at-risk accounts.",
    dataset_id: "churn_demo",
    target: "churned",
    metric: "recall",
    metric_rationale: "Catching churners is worth some false alarms.",
    constraints: { banned_columns: [] },
  });
  assert.equal(r.status, 201);
  ctx.studyId = r.json.id;

  r = await post("/api/profile", { study_id: ctx.studyId });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // The profiled contract reflects the UPLOADED CSV, not sla_tickets.
  const names = r.json.columns.map((c) => c.name);
  assert.ok(names.includes("monthly_spend"), "real columns from the uploaded CSV");
  assert.ok(!names.includes("breached_sla"), "must NOT be the sla_tickets profile");
  assert.ok(r.json.leakage_candidates.includes("account_closed_date"));
  assert.ok(r.json.banned_columns.includes("account_closed_date"), "leakage defaults to banned");
  assert.equal(r.json.split_strategy.strategy, "time_based");
});

test("grade: data_contract + target_metric_documented PASS generically when config is complete", async (t) => {
  if (!booted) return t.skip();
  const r = await get(`/api/studies/${ctx.studyId}/grade`);
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
  assert.equal(byId.data_contract.passed, true, byId.data_contract.detail);
  assert.equal(byId.target_metric_documented.passed, true, byId.target_metric_documented.detail);
  assert.equal(byId.study_created.passed, true);
});

test("grade: target_metric_documented FAILS when the metric rationale is missing", async (t) => {
  if (!booted) return t.skip();
  // A second uploaded dataset + a study WITHOUT a metric rationale.
  let r = await post("/api/datasets", { dataset_id: "churn_demo2", target: "churned", csv: churnCsv() });
  assert.equal(r.status, 201);
  r = await post("/api/studies", {
    brief: "Churn study with an incomplete metric contract.",
    dataset_id: "churn_demo2",
    target: "churned",
    metric: "recall",
    // no metric_rationale on purpose
  });
  assert.equal(r.status, 201);
  const sid = r.json.id;
  r = await post("/api/profile", { study_id: sid });
  assert.equal(r.status, 200);

  r = await get(`/api/studies/${sid}/grade`);
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
  // data_contract still passes (real profile exists), but target/metric doc fails.
  assert.equal(byId.data_contract.passed, true, byId.data_contract.detail);
  assert.equal(byId.target_metric_documented.passed, false, "should fail without a metric rationale");
});
