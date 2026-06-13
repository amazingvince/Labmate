/**
 * Contract test for the Labmate control plane (apps/web).
 *
 * This is the definition of done for the API surface. It:
 *   1. boots the Worker with the local `wrangler dev` (miniflare: D1 + R2 + DO),
 *   2. stands up a mock Modal runner the Worker submits manifests to,
 *   3. hits every route in apps/api-spec/openapi.yaml with the spec's example bodies,
 *   4. asserts each response validates against that route's response schema (ajv),
 *   5. asserts the guardrails: 401 without a token, 402 without an approval, and 422
 *      for a banned column in features or tune_on=test.
 *
 * Run on its own:   node --test tests/contract.api.test.mjs
 * (it is also part of `npm run test` / `npm run guard`).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const YAML = require("yaml");
const AjvMod = require("ajv/dist/2020");
const Ajv2020 = AjvMod.default || AjvMod;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-internal-token";

// ---------------------------------------------------------------------------
// spec + schema validation (ajv against the OpenAPI response schemas)
// ---------------------------------------------------------------------------
const spec = YAML.parse(readFileSync(join(root, "apps/api-spec/openapi.yaml"), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(spec, "openapi");

const ptr = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");

/** Build the ajv ref to a route's response schema, following $ref to components.responses. */
function responseSchemaRef(path, method, status) {
  const respObj = spec.paths[path][method].responses[String(status)];
  if (respObj && respObj.$ref) {
    // e.g. "#/components/responses/NotFound"
    const name = respObj.$ref.split("/").pop();
    return `openapi#/components/responses/${ptr(name)}/content/${ptr("application/json")}/schema`;
  }
  return `openapi#/paths/${ptr(path)}/${method}/responses/${status}/content/${ptr("application/json")}/schema`;
}

/** Validate `body` against the schema declared for path/method/status in the spec. */
function assertValidResponse(path, method, status, body) {
  const ref = responseSchemaRef(path, method, status);
  let validate;
  try {
    validate = ajv.getSchema(ref) || ajv.compile({ $ref: ref });
  } catch (e) {
    throw new Error(`could not compile response schema for ${method.toUpperCase()} ${path} ${status}: ${e.message}`);
  }
  const ok = validate(body);
  if (!ok) {
    throw new Error(
      `${method.toUpperCase()} ${path} ${status} response failed schema:\n` +
        `${JSON.stringify(validate.errors, null, 2)}\nbody: ${JSON.stringify(body, null, 2)}`,
    );
  }
}

// Example request bodies straight from the spec.
const EX = spec.components.examples;
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// process / server orchestration
// ---------------------------------------------------------------------------
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
let mock = null;
let BASE = "";
let wranglerLog = "";
let persistDir = "";

function startMockRunner(port) {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const m = JSON.parse(data || "{}");
        const send = (obj) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (m.search && m.search.enabled && m.search.tune_on === "test") {
          return send({ status: "rejected", reason: "tuning on test is not allowed" });
        }
        const fam = (m.model && m.model.family) || "logistic_regression";
        const isBaseline = (m.tags || []).includes("baseline");
        const bump = { random_forest: 0.06, hist_gradient_boosting: 0.09, lightgbm: 0.1, xgboost: 0.09 }[fam] || 0;
        const recall = Math.min(0.97, (isBaseline ? 0.62 : 0.78) + bump);
        return send({
          status: "completed",
          tracker_run_id: "trk_" + Math.random().toString(36).slice(2, 8),
          metrics: {
            recall_at_fpr: recall,
            recall,
            precision: 0.5 + bump,
            roc_auc: 0.8 + bump,
            pr_auc: 0.65 + bump,
            false_positive_rate: 0.18,
          },
          params: { family: fam, ...((m.model && m.model.params) || {}) },
          artifacts: { confusion_matrix: { uri: `studies/${m.study_id}/cm.json`, kind: "confusion_matrix" } },
          provenance: { dataset_hash: "sha256:demo", code_hash: "codehash1234", seed: (m.split && m.split.seed) || 42 },
        });
      });
    });
    mock.listen(port, "127.0.0.1", () => resolve());
  });
}

async function startWrangler(port, mockUrl, persistDir) {
  const bin = join(root, "node_modules/.bin/wrangler");
  wrangler = spawn(
    bin,
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistDir,
      "--var",
      `LABMATE_INTERNAL_TOKEN:${TOKEN}`,
      "--var",
      `MODAL_RUNNER_URL:${mockUrl}`,
      // Neutralize the agent-runtime trigger/proxy during the contract test, so
      // creating a study never fires at a real (deployed) runtime. wrangler.toml
      // [vars] may hold a live AGENT_RUNTIME_URL for the deployed Worker.
      "--var",
      "AGENT_RUNTIME_URL:",
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
    if (wrangler.exitCode !== null) {
      throw new Error(`wrangler exited early (code ${wrangler.exitCode}):\n${wranglerLog}`);
    }
    try {
      const res = await fetch(`${BASE}/api/studies`);
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`wrangler dev did not become ready in time:\n${wranglerLog}`);
}

// HTTP helpers
async function call(method, path, { body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers["authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const post = (path, body, auth = true) => call("POST", path, { body, auth });
const get = (path) => call("GET", path, {});

before(async () => {
  const [wp, mp] = await Promise.all([freePort(), freePort()]);
  // Start every run from a clean D1/R2 so the contract test proves the API against an empty DB.
  persistDir = join(root, "apps/web", ".mf-contract-test");
  rmSync(persistDir, { recursive: true, force: true });
  await startMockRunner(mp);
  await startWrangler(wp, `http://127.0.0.1:${mp}`, persistDir);
});

after(async () => {
  if (wrangler && wrangler.exitCode === null) {
    wrangler.kill("SIGTERM");
    await sleep(300);
    if (wrangler.exitCode === null) wrangler.kill("SIGKILL");
  }
  if (mock) await new Promise((r) => mock.close(r));
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

// Shared state across the ordered scenario.
const ctx = {};

// ---------------------------------------------------------------------------
// the scenario — every route, with spec example bodies + guardrails
// ---------------------------------------------------------------------------

test("auth: POST without a token is 401 (Error schema)", async () => {
  const r = await call("POST", "/api/studies", { body: clone(EX.CreateStudySlaTickets.value), auth: false });
  assert.equal(r.status, 401);
  assertValidResponse("/api/studies", "post", 401, r.json);
});

test("createStudy: 201 with the spec's sla_tickets example", async () => {
  const r = await post("/api/studies", clone(EX.CreateStudySlaTickets.value));
  assert.equal(r.status, 201);
  assertValidResponse("/api/studies", "post", 201, r.json);
  assert.ok(r.json.id.startsWith("study_"));
  assert.equal(r.json.status, "open");
  ctx.studyId = r.json.id;
});

test("listStudies: 200 and includes the new study", async () => {
  const r = await get("/api/studies");
  assert.equal(r.status, 200);
  assertValidResponse("/api/studies", "get", 200, r.json);
  assert.ok(r.json.studies.some((s) => s.id === ctx.studyId));
});

test("getStudy: 200 StudyDetail for the ledger", async () => {
  const r = await get(`/api/studies/${ctx.studyId}`);
  assert.equal(r.status, 200);
  assertValidResponse("/api/studies/{studyId}", "get", 200, r.json);
  assert.equal(r.json.study.id, ctx.studyId);
});

test("getStudy: 404 for an unknown study", async () => {
  const r = await get(`/api/studies/study_does_not_exist`);
  assert.equal(r.status, 404);
  assertValidResponse("/api/studies/{studyId}", "get", 404, r.json);
});

test("profileDataset: 200 DatasetVersion with leakage flagged", async () => {
  const r = await post("/api/profile", { study_id: ctx.studyId });
  assert.equal(r.status, 200);
  assertValidResponse("/api/profile", "post", 200, r.json);
  const leaky = r.json.columns.filter((c) => c.is_candidate_leakage).map((c) => c.name);
  assert.ok(leaky.includes("resolved_at"), "resolved_at should be flagged as leakage");
  assert.ok(r.json.split_strategy.seed === 42);
});

test("proposeExperiments: 200 with >=5 hypothesis cards", async () => {
  const r = await post("/api/experiments/propose", { study_id: ctx.studyId, n: 6 });
  assert.equal(r.status, 200);
  assertValidResponse("/api/experiments/propose", "post", 200, r.json);
  assert.ok(r.json.hypotheses.length >= 5);
  ctx.baselineHyp = r.json.hypotheses[0].id;
  ctx.tunedHyp = r.json.hypotheses[1].id;
});

test("requestApproval: 200 pending approval", async () => {
  const r = await post("/api/approvals/request", {
    study_id: ctx.studyId,
    experiment_ids: [ctx.baselineHyp],
    reason: "Launch baseline + one tuned model, ~10 min budget.",
    estimated_cost_seconds: 600,
  });
  assert.equal(r.status, 200);
  assertValidResponse("/api/approvals/request", "post", 200, r.json);
  assert.equal(r.json.status, "pending");
  ctx.approvalId = r.json.approval_id;
});

// A valid baseline manifest built from the spec's LaunchBaseline example.
function baselineManifest() {
  const ex = clone(EX.LaunchBaseline.value);
  ex.manifest.study_id = ctx.studyId;
  ex.manifest.hypothesis_id = ctx.baselineHyp;
  ex.approval_id = ctx.approvalId;
  return ex;
}

test("launchExperiment: 402 when no approval is on file", async () => {
  const r = await post("/api/experiments/launch", baselineManifest());
  assert.equal(r.status, 402);
  assertValidResponse("/api/experiments/launch", "post", 402, r.json);
});

test("recordHumanFeedback: 201 approval (compute gate is now satisfied)", async () => {
  const body = clone(EX.FeedbackApproval.value);
  body.study_id = ctx.studyId;
  body.target_id = ctx.approvalId;
  const r = await post("/api/feedback", body);
  assert.equal(r.status, 201);
  assertValidResponse("/api/feedback", "post", 201, r.json);
  assert.equal(r.json.type, "approval");
});

test("launchExperiment: 201 baseline Run with provenance", async () => {
  const r = await post("/api/experiments/launch", baselineManifest());
  assert.equal(r.status, 201);
  assertValidResponse("/api/experiments/launch", "post", 201, r.json);
  assert.equal(r.json.executor, "modal-runner");
  assert.equal(r.json.hypothesis_id, ctx.baselineHyp);
  assert.ok(r.json.tags.includes("baseline"));
  assert.ok(r.json.dataset_hash && r.json.code_hash, "run must carry provenance");
  assert.equal(typeof r.json.metrics.recall_at_fpr, "number");
  ctx.baselineRun = r.json.id;
});

test("launchExperiment: 201 a second, tuned (non-baseline) Run", async () => {
  const ex = baselineManifest();
  ex.manifest.hypothesis_id = ctx.tunedHyp;
  ex.manifest.model = { family: "hist_gradient_boosting" };
  ex.manifest.tags = ["tuned"];
  const r = await post("/api/experiments/launch", ex);
  assert.equal(r.status, 201);
  assertValidResponse("/api/experiments/launch", "post", 201, r.json);
  ctx.tunedRun = r.json.id;
});

test("launchExperiment: 422 when a banned/leaky column is in features", async () => {
  const ex = baselineManifest();
  ex.manifest.features = [...ex.manifest.features, "resolved_at"]; // banned leakage column
  const r = await post("/api/experiments/launch", ex);
  assert.equal(r.status, 422);
  assertValidResponse("/api/experiments/launch", "post", 422, r.json);
});

test("launchExperiment: 422 when tune_on=test", async () => {
  const ex = baselineManifest();
  ex.manifest.search = { enabled: true, max_trials: 10, tune_on: "test" };
  const r = await post("/api/experiments/launch", ex);
  assert.equal(r.status, 422);
  assertValidResponse("/api/experiments/launch", "post", 422, r.json);
});

test("queryRuns: 200 filter by tag=baseline", async () => {
  const r = await post("/api/runs/query", { study_id: ctx.studyId, tags: ["baseline"] });
  assert.equal(r.status, 200);
  assertValidResponse("/api/runs/query", "post", 200, r.json);
  assert.ok(r.json.runs.some((run) => run.id === ctx.baselineRun));
  assert.ok(!r.json.runs.some((run) => run.id === ctx.tunedRun), "tuned run should be filtered out by tag");
});

test("queryRuns: 200 filter by model_family + metric threshold", async () => {
  const r = await post("/api/runs/query", {
    study_id: ctx.studyId,
    model_family: "hist_gradient_boosting",
    metric_filters: [{ name: "recall_at_fpr", op: ">=", value: 0.7 }],
  });
  assert.equal(r.status, 200);
  assertValidResponse("/api/runs/query", "post", 200, r.json);
  assert.ok(r.json.runs.every((run) => run.metrics.recall_at_fpr >= 0.7));
});

test("recordHumanFeedback: 201 note → parsed constraints", async () => {
  const body = clone(EX.FeedbackRecall.value);
  body.study_id = ctx.studyId;
  const r = await post("/api/feedback", body);
  assert.equal(r.status, 201);
  assertValidResponse("/api/feedback", "post", 201, r.json);
});

test("writeReport: 201 Report comparing best vs baseline, stored in R2", async () => {
  const r = await post("/api/reports", { study_id: ctx.studyId, report_type: "model_card" });
  assert.equal(r.status, 201);
  assertValidResponse("/api/reports", "post", 201, r.json);
  assert.ok(r.json.uri.startsWith(`studies/${ctx.studyId}/report/`));
  assert.equal(r.json.compares_best_to_baseline, true);
  assert.ok(r.json.provenance.dataset_hash && r.json.provenance.code_hash);
  assert.equal(typeof r.json.provenance.seed, "number");
});

test("gradeStudy: 200 GradeResult covering every rubric check", async () => {
  const r = await post("/api/grade", { study_id: ctx.studyId });
  assert.equal(r.status, 200);
  assertValidResponse("/api/grade", "post", 200, r.json);
  assert.ok(["done", "not_done"].includes(r.json.verdict));
  // every rubric check id should appear in the result
  const rubric = JSON.parse(readFileSync(join(root, "docs/rubric.json"), "utf8"));
  const expected = new Set();
  for (const cat of rubric.categories) for (const c of cat.checks) expected.add(c.id);
  const got = new Set(r.json.checks.map((c) => c.id));
  for (const id of expected) assert.ok(got.has(id), `grade result missing check ${id}`);
  // structural checks must pass
  const byId = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
  assert.equal(byId.verifiable_without_human.passed, true);
  assert.equal(byId.sandboxed_only.passed, true);
});

test("gradeStudy: 404 for an unknown study", async () => {
  const r = await post("/api/grade", { study_id: "study_nope" });
  assert.equal(r.status, 404);
  assertValidResponse("/api/grade", "post", 404, r.json);
});

// ---------------------------------------------------------------------------
// drive a fresh study all the way to verdict=done (proves the rubric is satisfiable
// and exercises the additive record_critique / record_decision routes in order)
// ---------------------------------------------------------------------------

function manifestFor(studyId, hypId, family, tags, feedbackId) {
  const ex = clone(EX.LaunchBaseline.value);
  ex.manifest.study_id = studyId;
  ex.manifest.hypothesis_id = hypId;
  ex.manifest.model = { family };
  ex.manifest.tags = tags;
  if (feedbackId) ex.manifest.applied_feedback_id = feedbackId;
  ex.approval_id = ctx.approval2;
  return ex;
}

test("e2e setup: study #2 profiled, hypotheses proposed, approval + feedback recorded", async () => {
  let r = await post("/api/studies", clone(EX.CreateStudySlaTickets.value));
  assert.equal(r.status, 201);
  ctx.study2 = r.json.id;

  r = await post("/api/profile", { study_id: ctx.study2 });
  assert.equal(r.status, 200);

  r = await post("/api/experiments/propose", { study_id: ctx.study2, n: 6 });
  assert.equal(r.status, 200);
  ctx.hyps2 = r.json.hypotheses.map((h) => h.id);

  // approval BEFORE any run (compute gate); recorded as feedback type=approval
  r = await post("/api/approvals/request", { study_id: ctx.study2, reason: "Run baseline + 4 experiments" });
  assert.equal(r.status, 200);
  ctx.approval2 = r.json.approval_id;
  r = await post("/api/feedback", { study_id: ctx.study2, type: "approval", scope: "study", content: "Approved.", target_id: ctx.approval2 });
  assert.equal(r.status, 201);

  // a natural-language note whose parsed constraint will shape a later manifest
  r = await post("/api/feedback", clone({ ...EX.FeedbackRecall.value, study_id: ctx.study2 }));
  assert.equal(r.status, 201);
  ctx.note2 = r.json.id;
});

test("recordCritique: 201 leakage review BEFORE any tuned run (→ rerun)", async () => {
  const r = await post("/api/critiques", {
    study_id: ctx.study2,
    kind: "leakage",
    finding: "resolved_at / time_to_resolution are post-outcome; must stay banned before training.",
    recommendation: "Keep leakage columns out of features; rerun any manifest that included them.",
    led_to_decision: "rerun",
  });
  assert.equal(r.status, 201);
  assertValidResponse("/api/critiques", "post", 201, r.json);
  assert.equal(r.json.kind, "leakage");
});

test("e2e: launch baseline + 4 experiments (5 completed runs)", async () => {
  // baseline first
  let r = await post("/api/experiments/launch", manifestFor(ctx.study2, ctx.hyps2[0], "logistic_regression", ["baseline"]));
  assert.equal(r.status, 201);
  ctx.baseline2 = r.json.id;

  const families = ["random_forest", "hist_gradient_boosting", "lightgbm", "hist_gradient_boosting"];
  ctx.runs2 = [];
  for (let i = 0; i < families.length; i++) {
    // the third experiment applies the human-feedback constraint (feedback_affected_plan)
    const fb = i === 2 ? ctx.note2 : undefined;
    r = await post("/api/experiments/launch", manifestFor(ctx.study2, ctx.hyps2[i + 1], families[i], ["tuned"], fb));
    assert.equal(r.status, 201);
    ctx.runs2.push({ id: r.json.id, family: families[i], recall: r.json.metrics.recall_at_fpr });
  }
  // promote the best non-baseline run
  ctx.promoted2 = ctx.runs2.reduce((a, b) => (b.recall > a.recall ? b : a)).id;
});

test("recordCritique: 201 test-set-tuning catch (→ rerun) and a calibration review of the promoted run", async () => {
  let r = await post("/api/critiques", {
    study_id: ctx.study2,
    target_run_id: ctx.runs2[0].id,
    kind: "test_set_tuning",
    finding: "An early manifest tuned the threshold on test; that inflates recall.",
    recommendation: "Re-tune the threshold on validation and rerun.",
    led_to_decision: "rerun",
  });
  assert.equal(r.status, 201);
  assertValidResponse("/api/critiques", "post", 201, r.json);

  r = await post("/api/critiques", {
    study_id: ctx.study2,
    target_run_id: ctx.promoted2,
    kind: "calibration",
    finding: "Reliability curve checked; probabilities are well-calibrated at the chosen threshold.",
    recommendation: "Safe to promote.",
    led_to_decision: "promote",
  });
  assert.equal(r.status, 201);
});

test("recordDecision: 201 promote the reviewed run", async () => {
  const r = await post("/api/decisions", {
    study_id: ctx.study2,
    action: "promote",
    promoted_run_id: ctx.promoted2,
    reason: "Beats baseline on recall at FPR<=0.20 and passed the calibration check.",
  });
  assert.equal(r.status, 201);
  assertValidResponse("/api/decisions", "post", 201, r.json);
});

test("e2e: report + grade → verdict done, all required checks pass", async () => {
  let r = await post("/api/reports", { study_id: ctx.study2 });
  assert.equal(r.status, 201);
  assert.equal(r.json.compares_best_to_baseline, true);

  r = await post("/api/grade", { study_id: ctx.study2 });
  assert.equal(r.status, 200);
  assertValidResponse("/api/grade", "post", 200, r.json);

  const failed = r.json.checks.filter((c) => c.required && !c.passed);
  assert.equal(
    failed.length,
    0,
    `required checks still failing: ${JSON.stringify(failed.map((c) => `${c.id}: ${c.detail}`), null, 2)}`,
  );
  assert.equal(r.json.verdict, "done");
  assert.equal(r.json.passed_required, r.json.total_required);
});
