/**
 * Causal human-feedback loop — the end-to-end proof that recorded feedback MUTATES the
 * study's enforced contract (`study.constraints`) and therefore CHANGES what every
 * SUBSEQUENT experiment is launched with (and what the runner enforces).
 *
 * The chain under test:
 *   record_human_feedback (unambiguous note)
 *     → MERGE parsed constraints into study.constraints (FPR bound / metric / bans)
 *       → GET study reflects the change
 *         → the next launch reads study.constraints and passes the new bound to the
 *            runner (declared.max_fpr / declared.banned_columns)
 *           → that run's applied_feedback_id points at the feedback that changed it
 *
 * Boots the same local stack as the contract test (wrangler dev: D1 + R2 + DO) and a
 * mock Modal runner that RECORDS each payload so we can assert what reached the runner.
 *
 * Run on its own:   node --test tests/feedback.causal.test.mjs
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "dev-internal-token-0000000000000000";
const spec = YAML.parse(readFileSync(join(root, "apps/api-spec/openapi.yaml"), "utf8"));
const EX = spec.components.examples;
const clone = (v) => JSON.parse(JSON.stringify(v));
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
// Every payload the Worker submitted to the runner, newest last.
const runnerPayloads = [];

function startMockRunner(port) {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const m = JSON.parse(data || "{}");
        runnerPayloads.push(m);
        const fam = (m.model && m.model.family) || "logistic_regression";
        const isBaseline = (m.tags || []).includes("baseline");
        const bump = { random_forest: 0.06, hist_gradient_boosting: 0.09, lightgbm: 0.1 }[fam] || 0;
        const recall = Math.min(0.97, (isBaseline ? 0.62 : 0.78) + bump);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "completed",
            tracker_run_id: "trk_" + Math.random().toString(36).slice(2, 8),
            metrics: { recall_at_fpr: recall, recall, precision: 0.5 + bump, roc_auc: 0.8, pr_auc: 0.65, false_positive_rate: 0.1 },
            params: { family: fam, model: fam },
            artifacts: {},
            provenance: { dataset_hash: "sha256:demo", code_hash: "codehash1", seed: (m.split && m.split.seed) || 42 },
          }),
        );
      });
    });
    mock.listen(port, "127.0.0.1", () => resolve());
  });
}

async function startWrangler(port, mockUrl) {
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
    if (wrangler.exitCode !== null) throw new Error(`wrangler exited early (${wrangler.exitCode}):\n${wranglerLog}`);
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
  throw new Error(`wrangler dev did not become ready:\n${wranglerLog}`);
}

async function call(method, path, { body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers["authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => null);
  return { status: res.status, json: j };
}
const post = (path, body) => call("POST", path, { body, auth: true });
const get = (path) => call("GET", path, {});

/** Stand up a fresh, approved, profiled study with hypotheses ready to launch. */
async function freshStudy() {
  let r = await post("/api/studies", clone(EX.CreateStudySlaTickets.value));
  assert.equal(r.status, 201);
  const studyId = r.json.id;
  r = await post("/api/profile", { study_id: studyId });
  assert.equal(r.status, 200);
  r = await post("/api/experiments/propose", { study_id: studyId, n: 6 });
  assert.equal(r.status, 200);
  const hyps = r.json.hypotheses.map((h) => h.id);
  r = await post("/api/approvals/request", { study_id: studyId, reason: "approve experiments" });
  assert.equal(r.status, 200);
  const approvalId = r.json.approval_id;
  r = await post("/api/feedback", { study_id: studyId, type: "approval", scope: "study", content: "Approved.", target_id: approvalId });
  assert.equal(r.status, 201);
  return { studyId, hyps, approvalId };
}

/** Build a launch body. By default declares NO max_fpr, so the STUDY's (possibly
 *  mutated) bound is what flows to the runner — that's what proves causality. */
function launchBody(studyId, hypId, { tags = ["tuned"], family = "hist_gradient_boosting", features, feedbackId, maxFpr } = {}) {
  const ex = clone(EX.LaunchBaseline.value);
  ex.manifest.study_id = studyId;
  ex.manifest.hypothesis_id = hypId;
  ex.manifest.model = { family };
  ex.manifest.tags = tags;
  if (features) ex.manifest.features = features;
  if (maxFpr === undefined) delete ex.manifest.metric.max_fpr;
  else ex.manifest.metric.max_fpr = maxFpr;
  if (feedbackId) ex.manifest.applied_feedback_id = feedbackId;
  return ex;
}

before(async () => {
  const [wp, mp] = await Promise.all([freePort(), freePort()]);
  persistDir = join(root, "apps/web", ".mf-feedback-causal-test");
  rmSync(persistDir, { recursive: true, force: true });
  await startMockRunner(mp);
  await startWrangler(wp, `http://127.0.0.1:${mp}`);
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

// ---------------------------------------------------------------------------
// 1. tighten FPR → study mutated → next launch carries it → run links back
// ---------------------------------------------------------------------------
test("tightening FPR mutates the study and causally reaches the runner", async () => {
  const { studyId, hyps } = await freshStudy();

  // Sanity: the study starts at FPR <= 0.20.
  let r = await get(`/api/studies/${studyId}`);
  assert.match(JSON.stringify(r.json.study.constraints), /0\.20|0\.2\b/);

  // Record an unambiguous "tighten FPR to 0.10" note.
  r = await post("/api/feedback", {
    study_id: studyId,
    type: "human_feedback",
    scope: "study",
    content: "Recall matters most, but tighten the false positive rate to 10% — 20% is too loose.",
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.constraints_changed, true);
  assert.ok(
    (r.json.constraints_change_summary || []).some((s) => /false_positive_rate <= 0\.1/.test(s)),
    `summary should mention the FPR change: ${JSON.stringify(r.json.constraints_change_summary)}`,
  );
  const fbId = r.json.id;

  // GET study now shows the guardrail at 0.10.
  r = await get(`/api/studies/${studyId}`);
  assert.equal(r.status, 200);
  const cons = JSON.stringify(r.json.study.constraints || {});
  assert.match(cons, /0\.1\b/);
  assert.doesNotMatch(cons, /0\.20|"false_positive_rate <= 0\.2"/, `old 0.20 FPR guardrail should be gone: ${cons}`);

  // A SUBSEQUENT launch that declares NO max_fpr must inherit the mutated bound and
  // pass max_fpr:0.10 to the runner.
  runnerPayloads.length = 0;
  r = await post("/api/experiments/launch", launchBody(studyId, hyps[1]));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const payload = runnerPayloads[runnerPayloads.length - 1];
  assert.ok(payload && payload.declared, "runner should receive a declared block");
  assert.equal(payload.declared.max_fpr, 0.1, `runner should enforce the tightened bound: ${JSON.stringify(payload.declared)}`);

  // The run links back to the feedback that changed the contract.
  assert.equal(r.json.applied_feedback_id, fbId);
});

// ---------------------------------------------------------------------------
// 2. ban a feature → appended to banned_columns → manifest naming it is rejected
// ---------------------------------------------------------------------------
test("banning a feature mutates banned_columns and blocks a later manifest naming it", async () => {
  const { studyId, hyps } = await freshStudy();

  const r0 = await post("/api/feedback", {
    study_id: studyId,
    type: "human_feedback",
    scope: "study",
    content: "Stop using region — it's not reliable across tenants.",
  });
  assert.equal(r0.status, 201);
  assert.equal(r0.json.constraints_changed, true);

  // GET study: region is now a banned column.
  let r = await get(`/api/studies/${studyId}`);
  const banned = (r.json.study.constraints && r.json.study.constraints.banned_columns) || [];
  assert.ok(banned.includes("region"), `region should be banned: ${JSON.stringify(banned)}`);

  // A later manifest that names `region` in features is rejected (422).
  r = await post(
    "/api/experiments/launch",
    launchBody(studyId, hyps[1], {
      features: ["priority", "customer_tier", "region", "channel"],
    }),
  );
  assert.equal(r.status, 422, JSON.stringify(r.json));
  assert.match(JSON.stringify(r.json), /region/);

  // The same manifest WITHOUT region launches fine (proves the block is the new ban).
  r = await post(
    "/api/experiments/launch",
    launchBody(studyId, hyps[1], { features: ["priority", "customer_tier", "channel"] }),
  );
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

// ---------------------------------------------------------------------------
// 3. explicit precision-as-primary note flips the enforced metric
// ---------------------------------------------------------------------------
test("an explicit 'precision matters more' note flips the enforced primary_metric", async () => {
  const { studyId } = await freshStudy();
  const r0 = await post("/api/feedback", {
    study_id: studyId,
    type: "human_feedback",
    scope: "study",
    content: "Actually precision matters more than recall now — too many false alarms.",
  });
  assert.equal(r0.status, 201);
  assert.equal(r0.json.constraints_changed, true);
  const r = await get(`/api/studies/${studyId}`);
  assert.equal(r.json.study.constraints.primary_metric, "precision");
  // study.metric is kept coherent with the new primary metric.
  assert.equal(r.json.study.metric, "precision");
});

// ---------------------------------------------------------------------------
// 4. a vague note changes nothing
// ---------------------------------------------------------------------------
test("a vague note does not mutate the contract (constraints_changed:false)", async () => {
  const { studyId } = await freshStudy();
  const before = await get(`/api/studies/${studyId}`);
  const beforeCons = JSON.stringify(before.json.study.constraints || {});

  const r0 = await post("/api/feedback", {
    study_id: studyId,
    type: "note",
    scope: "study",
    content: "Looks good so far, keep going!",
  });
  assert.equal(r0.status, 201);
  assert.equal(r0.json.constraints_changed, false);
  assert.equal(r0.json.constraints_change_summary, undefined);

  const after = await get(`/api/studies/${studyId}`);
  assert.equal(JSON.stringify(after.json.study.constraints || {}), beforeCons);
});

// ---------------------------------------------------------------------------
// 5. restating the EXISTING contract is a no-op (idempotent), proving the merge is
//    additive rather than always-stamping a change.
// ---------------------------------------------------------------------------
test("restating the current FPR bound is a no-op", async () => {
  const { studyId } = await freshStudy();
  const r0 = await post("/api/feedback", {
    study_id: studyId,
    type: "human_feedback",
    scope: "study",
    content: "Keep false positives at or under 20%, same as before.",
  });
  assert.equal(r0.status, 201);
  assert.equal(r0.json.constraints_changed, false);
});

// ---------------------------------------------------------------------------
// 6. grade.feedback_affected_plan — passes for the causal case, FAILS when the only
//    feedback changed nothing.
// ---------------------------------------------------------------------------
test("feedback_affected_plan PASSES when a contract change is applied by a later run", async () => {
  const { studyId, hyps } = await freshStudy();
  const fb = await post("/api/feedback", {
    study_id: studyId,
    type: "human_feedback",
    scope: "study",
    content: "Tighten the false positive rate to 12%.",
  });
  assert.equal(fb.json.constraints_changed, true);
  // a later run that applies it
  const run = await post("/api/experiments/launch", launchBody(studyId, hyps[1], { feedbackId: fb.json.id, maxFpr: 0.1 }));
  assert.equal(run.status, 201, JSON.stringify(run.json));

  const g = await post("/api/grade", { study_id: studyId });
  assert.equal(g.status, 200);
  const check = g.json.checks.find((c) => c.id === "feedback_affected_plan");
  assert.ok(check, "grade result must include feedback_affected_plan");
  assert.equal(check.passed, true, `expected pass: ${check.detail}`);
});

test("feedback_affected_plan FAILS when feedback existed but changed nothing", async () => {
  const { studyId, hyps } = await freshStudy();
  // Only a vague note + a run that references no changing feedback.
  await post("/api/feedback", { study_id: studyId, type: "note", scope: "study", content: "Nice, carry on." });
  const run = await post("/api/experiments/launch", launchBody(studyId, hyps[1], { maxFpr: 0.2 }));
  assert.equal(run.status, 201, JSON.stringify(run.json));

  const g = await post("/api/grade", { study_id: studyId });
  assert.equal(g.status, 200);
  const check = g.json.checks.find((c) => c.id === "feedback_affected_plan");
  assert.ok(check, "grade result must include feedback_affected_plan");
  assert.equal(check.passed, false, `expected fail: ${check.detail}`);
});
