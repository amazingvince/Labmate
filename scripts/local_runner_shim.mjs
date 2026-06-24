/**
 * Local runner shim — a no-Modal stand-in for the Modal runner endpoint
 * (apps/modal-runner/runner.py `launch`). The Cloudflare Worker
 * (apps/web/src/worker.js `runOnModal`) POSTs an experiment payload here exactly as it
 * would to Modal; we return a response in the SAME shape the Worker parses:
 *
 *   { status: "completed",
 *     metrics: { recall_at_fpr, recall, precision, false_positive_rate, roc_auc,
 *                pr_auc, brier },
 *     params:  { model, family, tags, max_fpr, ... },
 *     artifacts: { confusion_matrix, feature_importance, dummy, features,
 *                  n_train, n_val, n_test },
 *     provenance: { dataset_hash, code_hash, deps_hash, seed },
 *     fpr_guardrail_satisfied: <bool> }
 *
 * Two modes (env):
 *   MOCK=1 (default) — deterministic, plausible, MONOTONICALLY-IMPROVING metrics so the
 *     agent can pick a "best". A baseline (DummyClassifier/"baseline") lands ~recall
 *     0.28; a tuned model scores higher (and climbs with feature signal). The returned
 *     fpr_guardrail_satisfied is computed against the declared max_fpr, and the returned
 *     feature list reflects the banned-column-stripped declared features. No network, no
 *     sklearn.
 *
 *   REAL=1 — run the agent-authored python script via scripts/real_runner.py on the real
 *     CSV from LABMATE_DATASET_BASE / dataset_uri (or examples/sla_tickets/data.csv).
 *     Requires a python venv with pandas/scikit-learn. Falls back to a clear failed
 *     result (never 500s) if python/sklearn is unavailable.
 *
 * The shim NEVER 500s — like the real runner, any failure becomes a recordable result
 * with a distinct `reason` so the Worker records a run instead of erroring.
 *
 *   PORT (default 8899)   the port to listen on
 *   MOCK=1 | REAL=1       mode (MOCK default)
 *   PY (default python3)  python interpreter for REAL mode
 */
import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const PORT = Number(process.env.PORT || 8899);
const REAL = process.env.REAL === "1" || process.env.REAL === "true";
const PY = process.env.PY || "python3";

// Stable provenance hashes for the shim (distinct from the live runner so a run's
// provenance honestly reflects it ran on the local shim, not Modal).
const CODE_HASH = "shim" + crypto.createHash("sha256").update("local_runner_shim.mjs").digest("hex").slice(0, 8);
const DEPS_HASH = "shimdeps";

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** A deterministic [0,1) pseudo-random from a string seed (for stable mock metrics). */
function seededUnit(s) {
  const h = crypto.createHash("sha256").update(String(s)).digest();
  let n = 0;
  for (let i = 0; i < 6; i += 1) n = n * 256 + h[i];
  return n / 2 ** 48;
}

function round(x, p = 6) {
  return Number(x.toFixed(p));
}

/**
 * MOCK metrics. Baseline (dummy) is degenerate-but-valid: low recall, fpr <= max_fpr.
 * Tuned models improve with feature signal + a per-script jitter so a clear "best"
 * emerges across launches. Deterministic: the SAME script/seed always scores the same.
 */
function mockResult(payload) {
  const declared = payload.declared || {};
  const script = payload.script || "";
  const banned = new Set(declared.banned_columns || []);
  // Feature list the run "used", with banned columns stripped (reflects the physical
  // leakage strip the real runner does).
  const declaredFeatures = (declared.features || []).filter((c) => !banned.has(c));

  const maxFpr = declared.max_fpr != null ? Number(declared.max_fpr) : 0.2;
  const seed = declared.seed ?? 42;

  // Detect a baseline/dummy from the script text. The Worker passes tags on the manifest
  // (not in `declared`), so we sniff the script for the usual baseline shapes.
  const lower = String(script).toLowerCase();
  const isBaseline =
    /dummy(classifier|regressor)/.test(lower) ||
    /\bbaseline\b/.test(lower) ||
    /strategy\s*=\s*['"](most_frequent|prior|stratified|mean|median)['"]/.test(lower);

  const featSignal = Math.min(1, declaredFeatures.length / 11); // 11 safe features
  const scriptJitter = seededUnit(`${seed}:${script.length}:${lower.slice(0, 200)}`);

  let recall;
  let fpr;
  let precision;
  let rocAuc;
  let prAuc;
  let brier;
  let family;

  if (isBaseline) {
    recall = round(0.26 + 0.04 * scriptJitter); // ~0.26-0.30
    fpr = round(Math.min(maxFpr, 0.02 + 0.03 * scriptJitter));
    precision = round(0.3 + 0.05 * scriptJitter);
    rocAuc = round(0.5 + 0.02 * scriptJitter);
    prAuc = round(0.3 + 0.03 * scriptJitter);
    brier = round(0.23 + 0.02 * scriptJitter);
    family = /regress/.test(lower) ? "dummy_regressor" : "dummy";
  } else {
    recall = round(0.45 + 0.3 * featSignal + 0.07 * scriptJitter); // ~0.45-0.82
    fpr = round(Math.min(maxFpr, 0.1 + 0.08 * scriptJitter)); // <= max_fpr
    precision = round(0.55 + 0.2 * featSignal + 0.05 * scriptJitter);
    rocAuc = round(0.72 + 0.12 * featSignal + 0.04 * scriptJitter);
    prAuc = round(0.6 + 0.18 * featSignal + 0.04 * scriptJitter);
    brier = round(0.18 - 0.05 * featSignal);
    if (/gradientboost|histgradient|xgb|lightgbm|gbm/.test(lower)) family = "gradient_boosting";
    else if (/randomforest|random_forest/.test(lower)) family = "random_forest";
    else family = "logistic_regression";
  }

  const fprOk = fpr <= maxFpr + 1e-9;

  // Drill-down context fields the cockpit's Context line renders (RunsTable.tsx):
  //   "prevalence train X% / test Y%" and "tuned @ FPR {target_fpr} → threshold {threshold}".
  // The real runner / live data emit these; emit them here too for demo fidelity.
  // target_fpr is the declared guardrail ceiling (default 0.10). Because `fpr` above is
  // always <= maxFpr, false_positive_rate <= target_fpr holds whenever fprOk is true.
  const targetFpr = round(declared.max_fpr != null ? Number(declared.max_fpr) : 0.1);
  // Deterministic operating threshold in (0,1), tied to the same seed/script jitter as the
  // other monotonic metrics (no Math.random). Baselines (predict prior) sit near the class
  // prior ~0.36; tuned models calibrate near 0.5. Small jitter keeps runs distinguishable.
  const threshold = isBaseline
    ? round(0.34 + 0.05 * scriptJitter) // ~0.34-0.39, near the positive prior
    : round(0.45 + 0.1 * scriptJitter); // ~0.45-0.55, a calibrated operating point
  // Plausible class prevalences (~36% positive), with a tiny deterministic train/test gap
  // from a time-based split. prevalence_test stays consistent with the confusion matrix's
  // ~35% positive test prevalence below.
  const prevalenceTrain = round(0.362 + 0.01 * scriptJitter);
  const prevalenceTest = round(0.35 + 0.008 * scriptJitter);

  const nRows = 12000;
  const nTrain = Math.round(nRows * 0.7);
  const nVal = Math.round(nRows * 0.15);
  const nTest = nRows - nTrain - nVal;

  // A plausible confusion matrix at the chosen threshold (test split).
  const pos = Math.round(nTest * 0.35); // ~35% positive prevalence
  const neg = nTest - pos;
  const tp = Math.round(pos * recall);
  const fn = pos - tp;
  const fp = Math.round(neg * fpr);
  const tn = neg - fp;

  return {
    status: "completed",
    metrics: {
      recall_at_fpr: recall,
      recall,
      precision,
      false_positive_rate: fpr,
      roc_auc: rocAuc,
      pr_auc: prAuc,
      brier,
      // Echo the FPR BOUND the Worker actually sent us (study.constraints → declared.max_fpr)
      // into metrics so it is OBSERVABLE per run. It is a number, so it survives the Worker's
      // numbers-only metric filter (numbersOnly) and lands on run.metrics.max_fpr — letting a
      // reader (and the e2e driver) see the guardrail that was IN FORCE when this run launched.
      // This is the observable proof that human feedback ("tighten FPR to 0.10") causally
      // changed the enforced contract: pre-feedback runs report 0.20, post-feedback runs 0.10.
      max_fpr: maxFpr,
      target_fpr: targetFpr,
      threshold,
      prevalence_train: prevalenceTrain,
      prevalence_test: prevalenceTest,
    },
    params: {
      model: family,
      family,
      max_fpr: maxFpr,
      tune_on: declared.tune_on || "validation",
      primary_metric: declared.primary_metric || "recall_at_fpr",
    },
    artifacts: {
      confusion_matrix: { kind: "confusion_matrix", data: { tp, fp, tn, fn } },
      feature_importance: Object.fromEntries(
        declaredFeatures.map((f, i) => [f, round((declaredFeatures.length - i) / (declaredFeatures.length || 1) / 2)]),
      ),
      dummy: isBaseline,
      features: declaredFeatures,
      n_train: nTrain,
      n_val: nVal,
      n_test: nTest,
    },
    provenance: {
      dataset_hash:
        "shimds" + crypto.createHash("sha256").update(payload.dataset_uri || "sla_tickets").digest("hex").slice(0, 6),
      code_hash: CODE_HASH,
      deps_hash: DEPS_HASH,
      seed,
    },
    fpr_guardrail_satisfied: fprOk,
  };
}

/** REAL mode: run the agent-authored script via the local python helper. */
function realResult(payload) {
  const helper = join(__dirname, "real_runner.py");
  if (!existsSync(helper)) {
    return {
      status: "failed",
      reason: "real_helper_missing",
      provenance: { code_hash: CODE_HASH, deps_hash: DEPS_HASH, seed: (payload.declared || {}).seed },
    };
  }
  const proc = spawnSync(PY, [helper], {
    input: JSON.stringify({ ...payload, repo: REPO }),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300000,
  });
  if (proc.error) {
    return {
      status: "failed",
      reason: `real_spawn_error:${proc.error.code || proc.error.message}`,
      provenance: { code_hash: CODE_HASH, deps_hash: DEPS_HASH, seed: (payload.declared || {}).seed },
    };
  }
  const out = (proc.stdout || "").trim();
  try {
    return JSON.parse(out);
  } catch {
    const tail = (proc.stderr || out || "").split("\n").slice(-3).join(" | ").slice(0, 300);
    return {
      status: "failed",
      reason: `real_bad_output:${tail}`,
      provenance: { code_hash: CODE_HASH, deps_hash: DEPS_HASH, seed: (payload.declared || {}).seed },
    };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    return send(res, 200, { ok: true, mode: REAL ? "REAL" : "MOCK" });
  }
  if (req.method !== "POST") return send(res, 404, { error: "not_found" });
  const payload = await readBody(req);
  try {
    const result = REAL ? realResult(payload) : mockResult(payload);
    return send(res, 200, result);
  } catch (e) {
    // Never 500 — mirror the runner's never-crash contract.
    return send(res, 200, {
      status: "failed",
      reason: `shim_error:${e?.message ?? e}`,
      provenance: { code_hash: CODE_HASH, deps_hash: DEPS_HASH, seed: (payload?.declared || {}).seed ?? null },
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.info(`local runner shim (${REAL ? "REAL" : "MOCK"}) listening on http://127.0.0.1:${PORT}`);
});
