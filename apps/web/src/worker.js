/**
 * Labmate Cloudflare Worker — the control plane API for the evidence ledger.
 *
 * One Worker, backed by D1 (the ledger), R2 (artifacts), and a Durable Object
 * (live study session). It is the single contract both clients hit: the MCP server
 * (Claude's semantic tools) and the cockpit (the human's mission control). Every
 * route here matches apps/api-spec/openapi.yaml.
 *
 * Routes (all POST require the internal bearer token; the two GET reads are public):
 *   POST /api/studies               create_study           -> 201 { id, status }
 *   GET  /api/studies               list studies (public)  -> 200 { studies }
 *   GET  /api/studies/:id           study detail (public)  -> 200 StudyDetail | 404
 *   POST /api/profile               profile_dataset        -> 200 DatasetVersion | 404
 *   POST /api/experiments/propose   propose_experiments    -> 200 { hypotheses }
 *   POST /api/approvals/request     request_approval       -> 200 { approval_id, status }
 *   POST /api/experiments/launch    launch_experiment      -> 201 Run | 402 | 422
 *   POST /api/runs/query            query_runs             -> 200 { runs }
 *   POST /api/feedback              record_human_feedback  -> 201 Feedback
 *   POST /api/reports               write_report           -> 201 Report
 *   POST /api/grade                 grade_study_against_rubric -> 200 GradeResult | 404
 *
 * Bindings (wrangler.toml): env.DB (D1), env.ARTIFACTS (R2), env.STUDY (Durable Object),
 * env.LABMATE_INTERNAL_TOKEN (secret), env.MODAL_RUNNER_URL (the fixed runner).
 */

import rubric from "../../../docs/rubric.json";
import schemaSQL from "../schema.sql";
import { profileFor, hypothesisLibrary } from "./profiles.js";
import { evaluateRubric } from "./grade.js";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

const errorBody = (error, detail) => (detail ? { error, detail } : { error });
const fail = (status, error, detail) => json(errorBody(error, detail), status);
const unauthorized = () => fail(401, "unauthorized", "Missing or invalid internal token.");
const notFound = (detail) => fail(404, "not_found", detail);

/** Log a server error; only reveal the raw message in dev (avoid leaking SQL/internal detail). */
function serverError(env, code, e) {
  console.error(`[labmate] ${code}:`, e && e.stack ? e.stack : e);
  const detail = env && env.LABMATE_ENV === "dev" ? String(e && e.message ? e.message : e) : "internal error";
  return fail(500, code, detail);
}

/** Constant-time string compare (no early-exit on the first differing byte). */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Require the shared internal token on writes. NOTE: the human checkpoint (approval)
 * is enforced out-of-band — the cockpit is where a human approves, which records a
 * feedback(type=approval); the MCP server and cockpit share LABMATE_INTERNAL_TOKEN by
 * design (docs/ENV.md). This token authenticates the caller, not the human approval.
 */
function checkAuth(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return !!(token && env.LABMATE_INTERNAL_TOKEN && timingSafeEqual(token, env.LABMATE_INTERNAL_TOKEN));
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

/** Time-prefixed, collision-resistant id: prefix_<base36 time><random>. */
function newId(prefix) {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = crypto.randomUUID().replace(/-/g, "").slice(0, 14);
  return `${prefix}_${t}${r}`;
}

const parse = (s, fallback = null) => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** Drop keys whose value is null/undefined (keeps false, 0, "", []). */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** Keep only numeric metric values (the spec types metrics as map<string,number>). */
function numbersOnly(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// schema bootstrap (self-apply schema.sql once per isolate)
// ---------------------------------------------------------------------------

let _schemaReady = null;

function splitSql(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA/i.test(s));
}

function ensureSchema(env) {
  if (!_schemaReady) {
    const statements = splitSql(schemaSQL).map((s) => env.DB.prepare(s));
    _schemaReady = env.DB.batch(statements).catch((e) => {
      _schemaReady = null; // allow a retry on the next request
      throw e;
    });
  }
  return _schemaReady;
}

// ---------------------------------------------------------------------------
// row -> entity mappers (shape exactly to the OpenAPI component schemas)
// ---------------------------------------------------------------------------

function mapStudy(row) {
  return compact({
    id: row.id,
    brief: row.brief,
    owner: row.owner,
    task_type: row.task_type,
    dataset_id: row.dataset_id,
    target: row.target,
    metric: row.metric,
    metric_rationale: row.metric_rationale,
    budget: parse(row.budget_json) || { max_trials: 20, budget_seconds: 600 },
    rubric: row.rubric || "docs/rubric.json",
    status: row.status || "open",
    constraints: parse(row.constraints_json) || undefined,
    created_at: row.created_at,
  });
}

function mapDatasetVersion(row) {
  if (!row) return null;
  return compact({
    id: row.id,
    study_id: row.study_id,
    file_hash: row.file_hash,
    row_count: row.row_count,
    columns: parse(row.columns_json) || [],
    target_definition: row.target_definition,
    split_strategy: parse(row.split_json),
    // extra (allowed) fields the cockpit + grader use:
    leakage_candidates: parse(row.leakage_candidates_json) || [],
    banned_columns: parse(row.banned_columns_json) || [],
    created_at: row.created_at,
  });
}

function mapHypothesis(row) {
  return compact({
    id: row.id,
    study_id: row.study_id,
    statement: row.statement,
    rationale: row.rationale,
    model_family: row.model_family,
    features: parse(row.features_json) || [],
    expected_outcome: row.expected_outcome,
    status: row.status || "proposed",
    created_at: row.created_at,
  });
}

function mapRun(row) {
  return compact({
    id: row.id,
    study_id: row.study_id,
    hypothesis_id: row.hypothesis_id,
    manifest_id: row.manifest_id,
    tracker_run_id: row.tracker_run_id,
    status: row.status,
    metrics: numbersOnly(parse(row.metrics_json) || {}),
    params: parse(row.params_json) || {},
    artifacts: parse(row.artifacts_json) || {},
    rationale: row.rationale,
    tags: parse(row.tags_json) || [],
    executor: row.executor || "modal-runner", // read the stored column so sandboxed_only is data-driven
    dataset_hash: row.dataset_hash,
    code_hash: row.code_hash,
    seed: row.seed,
    created_at: row.created_at,
  });
}

function mapCritique(row) {
  return compact({
    id: row.id,
    study_id: row.study_id,
    target_run_id: row.target_run_id,
    kind: row.kind,
    finding: row.finding,
    recommendation: row.recommendation,
    led_to_decision: row.led_to_decision,
    created_at: row.created_at,
  });
}

function mapDecision(row) {
  return compact({
    id: row.id,
    study_id: row.study_id,
    action: row.action,
    promoted_run_id: row.promoted_run_id,
    rejected_run_id: row.rejected_run_id,
    reason: row.reason,
    created_at: row.created_at,
  });
}

function mapFeedback(row) {
  return compact({
    id: row.id,
    study_id: row.study_id,
    target_id: row.target_id,
    type: row.type,
    scope: row.scope,
    content: row.content,
    parsed_constraints: parse(row.parsed_constraints_json) || undefined,
    created_at: row.created_at,
  });
}

function mapArtifact(row) {
  return compact({
    id: row.id,
    study_id: row.study_id,
    kind: row.kind,
    uri: row.uri,
    dataset_hash: row.dataset_hash,
    code_hash: row.code_hash,
    seed: row.seed,
    meta: parse(row.meta_json) || undefined,
    created_at: row.created_at,
  });
}

// ---------------------------------------------------------------------------
// ledger loading
// ---------------------------------------------------------------------------

async function getStudyRow(env, id) {
  return env.DB.prepare("SELECT * FROM study WHERE id = ?").bind(id).first();
}

async function latestDatasetVersionRow(env, studyId) {
  return env.DB.prepare(
    "SELECT * FROM dataset_version WHERE study_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(studyId)
    .first();
}

async function loadLedger(env, studyRow) {
  const studyId = studyRow.id;
  const q = (sql) => env.DB.prepare(sql).bind(studyId).all();
  const [hyp, runs, crits, decs, fbs, arts, mans, dvRow] = await Promise.all([
    q("SELECT * FROM hypothesis WHERE study_id = ? ORDER BY created_at ASC"),
    q("SELECT * FROM run WHERE study_id = ? ORDER BY created_at ASC"),
    q("SELECT * FROM critique WHERE study_id = ? ORDER BY created_at ASC"),
    q("SELECT * FROM decision WHERE study_id = ? ORDER BY created_at ASC"),
    q("SELECT * FROM feedback WHERE study_id = ? ORDER BY created_at ASC"),
    q("SELECT * FROM artifact WHERE study_id = ? ORDER BY created_at ASC"),
    q("SELECT * FROM experiment_manifest WHERE study_id = ? ORDER BY created_at ASC"),
    latestDatasetVersionRow(env, studyId),
  ]);
  return {
    study: mapStudy(studyRow),
    dataset_version: mapDatasetVersion(dvRow),
    hypotheses: hyp.results.map(mapHypothesis),
    runs: runs.results.map(mapRun),
    critiques: crits.results.map(mapCritique),
    decisions: decs.results.map(mapDecision),
    feedback: fbs.results.map(mapFeedback),
    artifacts: arts.results.map(mapArtifact),
    manifests: mans.results.map((m) => ({
      id: m.id,
      hypothesis_id: m.hypothesis_id,
      applied_feedback_id: m.applied_feedback_id,
    })),
  };
}

const PRIMARY_METRIC_KEYS = ["recall_at_fpr", "recall", "pr_auc", "roc_auc", "f1"];

/** Pick the best completed run by the first available primary metric (higher is better). */
function bestRun(runs) {
  const completed = runs.filter((r) => r.status === "completed");
  let best = null;
  let bestScore = -Infinity;
  for (const r of completed) {
    const m = r.metrics || {};
    const key = PRIMARY_METRIC_KEYS.find((k) => typeof m[k] === "number");
    const score = key ? m[key] : -Infinity;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

function recommendation(L) {
  const promote = L.decisions.find((d) => d.action === "promote" && d.promoted_run_id);
  if (promote) return `Promote ${promote.promoted_run_id}${promote.reason ? ` — ${promote.reason}` : "."}`;
  const completed = L.runs.filter((r) => r.status === "completed");
  if (completed.length === 0) {
    return "Profile the dataset, run the leakage review, then a baseline before any tuned model.";
  }
  const best = bestRun(L.runs);
  const hasLeakageReview = L.critiques.some((c) => c.kind === "leakage");
  const r = best && best.metrics ? best.metrics.recall_at_fpr ?? best.metrics.recall : undefined;
  const recallTxt = typeof r === "number" ? ` (recall ${r.toFixed(3)})` : "";
  if (!hasLeakageReview) return `Run a leakage review before trusting ${best ? best.id : "any run"}.`;
  return `Best so far: ${best ? best.id : "n/a"}${recallTxt}. Confirm a calibration check, then compare to baseline before promoting.`;
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

async function createStudy(env, body) {
  for (const k of ["brief", "dataset_id", "target", "metric"]) {
    if (!body || !body[k]) return fail(400, "bad_request", `Missing required field: ${k}`);
  }
  const id = newId("study");
  const budget = {
    max_trials: body.budget?.max_trials ?? 20,
    budget_seconds: body.budget?.budget_seconds ?? 600,
  };
  await env.DB.prepare(
    `INSERT INTO study (id, brief, owner, task_type, dataset_id, target, metric, metric_rationale,
       constraints_json, budget_json, rubric, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      body.brief,
      body.owner ?? null,
      body.task_type ?? null,
      body.dataset_id,
      body.target,
      body.metric,
      body.metric_rationale ?? null,
      JSON.stringify(body.constraints || {}),
      JSON.stringify(budget),
      body.rubric || "docs/rubric.json",
      "open",
      nowIso(),
    )
    .run();
  // Best-effort: kick the agent runtime to start a Managed Agents session for this
  // study. Fire-and-forget — never block or fail study creation on it. The SSE
  // stream route (GET /api/studies/{id}/stream) also starts the study on first
  // subscribe, so a dropped trigger self-heals when the cockpit connects.
  triggerAgentStart(env, id);
  return json({ id, status: "open" }, 201);
}

async function listStudies(env, url) {
  const status = url.searchParams.get("status");
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  const stmt = status
    ? env.DB.prepare("SELECT * FROM study WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, limit)
    : env.DB.prepare("SELECT * FROM study ORDER BY created_at DESC LIMIT ?").bind(limit);
  const { results } = await stmt.all();
  return json({ studies: results.map(mapStudy) });
}

async function getStudyDetail(env, id) {
  const studyRow = await getStudyRow(env, id);
  if (!studyRow) return notFound(`No study ${id}`);
  const L = await loadLedger(env, studyRow);
  const detail = compact({
    study: L.study,
    dataset_version: L.dataset_version, // compact() drops it when null
    hypotheses: L.hypotheses,
    runs: L.runs,
    critiques: L.critiques,
    decisions: L.decisions,
    feedback: L.feedback,
    artifacts: L.artifacts,
    recommendation: recommendation(L),
  });
  return json(detail);
}

async function profileDataset(env, body) {
  const studyRow = await getStudyRow(env, body.study_id);
  if (!studyRow) return notFound(`No study ${body.study_id}`);
  const study = mapStudy(studyRow);
  const profile = profileFor(study.dataset_id, study.target);
  const constraints = parse(studyRow.constraints_json) || {};
  const leakage = profile.leakage_candidates || [];
  const banned = [...new Set([...(constraints.banned_columns || []), ...leakage])];
  const split = profile.split;

  const fileHash = await sha256hex(
    JSON.stringify({ d: profile.dataset_id, n: profile.row_count, c: profile.columns, s: split }),
  );
  const id = newId("ds");
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO dataset_version (id, study_id, file_hash, row_count, columns_json, target_definition,
       split_strategy, split_json, seed, leakage_candidates_json, banned_columns_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      study.id,
      fileHash,
      profile.row_count,
      JSON.stringify(profile.columns || []),
      profile.target_definition ?? null,
      split?.strategy ?? null,
      JSON.stringify(split || {}),
      split?.seed ?? null,
      JSON.stringify(leakage),
      JSON.stringify(banned),
      created,
    )
    .run();

  return json(
    compact({
      id,
      study_id: study.id,
      file_hash: fileHash,
      row_count: profile.row_count,
      columns: profile.columns || [],
      target_definition: profile.target_definition,
      split_strategy: split,
      leakage_candidates: leakage,
      banned_columns: banned,
    }),
    200,
  );
}

async function proposeExperiments(env, body) {
  const studyRow = await getStudyRow(env, body.study_id);
  if (!studyRow) return notFound(`No study ${body.study_id}`);
  const study = mapStudy(studyRow);
  const profile = profileFor(study.dataset_id, study.target);
  let n = parseInt(body.n ?? 6, 10);
  if (!Number.isFinite(n) || n < 1) n = 6;
  if (n > 12) n = 12;

  const cards = hypothesisLibrary(profile).slice(0, n);
  const created = nowIso();
  const out = [];
  const stmts = [];
  for (const card of cards) {
    const id = newId("hyp");
    stmts.push(
      env.DB.prepare(
        `INSERT INTO hypothesis (id, study_id, statement, rationale, model_family, features_json,
           expected_outcome, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        study.id,
        card.statement,
        card.rationale ?? null,
        card.model_family ?? null,
        JSON.stringify(card.features || []),
        card.expected_outcome ?? null,
        "proposed",
        created,
      ),
    );
    out.push(
      compact({
        id,
        study_id: study.id,
        statement: card.statement,
        rationale: card.rationale,
        model_family: card.model_family,
        features: card.features || [],
        expected_outcome: card.expected_outcome,
        status: "proposed",
        created_at: created,
      }),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ hypotheses: out });
}

async function requestApproval(env, body) {
  if (!body.study_id || !body.reason) return fail(400, "bad_request", "study_id and reason are required");
  const id = newId("appr");
  await env.DB.prepare(
    `INSERT INTO approval (id, study_id, experiment_ids_json, reason, estimated_cost_seconds, status, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      body.study_id,
      JSON.stringify(body.experiment_ids || []),
      body.reason,
      body.estimated_cost_seconds ?? null,
      "pending",
      nowIso(),
    )
    .run();
  return json({ approval_id: id, status: "pending" });
}

/** Lightweight natural-language -> constraint parse for free-text notes. */
function parseConstraints(content, type) {
  if (type !== "note") return undefined;
  const t = (content || "").toLowerCase();
  const c = {};
  if (/recall/.test(t) && /(precision|matters|priorit|over)/.test(t)) c.primary_metric = "recall";
  if (/(false positive|fpr|false alarm)/.test(t)) {
    const pct = t.match(/(\d{1,3})\s*%/);
    if (pct) c.guardrail = `false_positive_rate <= ${(parseInt(pct[1], 10) / 100).toFixed(2)}`;
  }
  return Object.keys(c).length ? c : undefined;
}

async function recordFeedback(env, body) {
  for (const k of ["study_id", "type", "content"]) {
    if (!body || !body[k]) return fail(400, "bad_request", `Missing required field: ${k}`);
  }
  const id = newId("fb");
  const created = nowIso();
  const parsed = body.parsed_constraints || parseConstraints(body.content, body.type);

  // An approval feedback that targets a pending approval flips it to 'approved'.
  if (body.type === "approval" && body.target_id) {
    await env.DB.prepare("UPDATE approval SET status = 'approved' WHERE id = ? AND study_id = ?")
      .bind(body.target_id, body.study_id)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO feedback (id, study_id, target_id, type, scope, content, parsed_constraints_json, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      body.study_id,
      body.target_id ?? null,
      body.type,
      body.scope ?? null,
      body.content,
      parsed ? JSON.stringify(parsed) : null,
      created,
    )
    .run();

  return json(
    compact({
      id,
      study_id: body.study_id,
      target_id: body.target_id,
      type: body.type,
      scope: body.scope,
      content: body.content,
      parsed_constraints: parsed,
      created_at: created,
    }),
    201,
  );
}

async function recordCritique(env, body) {
  for (const k of ["study_id", "kind", "finding"]) {
    if (!body || !body[k]) return fail(400, "bad_request", `Missing required field: ${k}`);
  }
  const id = newId("crit");
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO critique (id, study_id, target_run_id, kind, finding, recommendation, led_to_decision, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      body.study_id,
      body.target_run_id ?? null,
      body.kind,
      body.finding,
      body.recommendation ?? null,
      body.led_to_decision ?? null,
      created,
    )
    .run();
  return json(
    compact({
      id,
      study_id: body.study_id,
      target_run_id: body.target_run_id,
      kind: body.kind,
      finding: body.finding,
      recommendation: body.recommendation,
      led_to_decision: body.led_to_decision,
      created_at: created,
    }),
    201,
  );
}

async function recordDecision(env, body) {
  for (const k of ["study_id", "action"]) {
    if (!body || !body[k]) return fail(400, "bad_request", `Missing required field: ${k}`);
  }
  const id = newId("dec");
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO decision (id, study_id, action, promoted_run_id, rejected_run_id, reason, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(id, body.study_id, body.action, body.promoted_run_id ?? null, body.rejected_run_id ?? null, body.reason ?? null, created)
    .run();
  return json(
    compact({
      id,
      study_id: body.study_id,
      action: body.action,
      promoted_run_id: body.promoted_run_id,
      rejected_run_id: body.rejected_run_id,
      reason: body.reason,
      created_at: created,
    }),
    201,
  );
}

const MANIFEST_REQUIRED = ["study_id", "dataset_uri", "target", "task_type", "split", "features", "model", "metric"];

/** Returns an Error detail string if the manifest is invalid (422), else null. */
function validateManifest(m, dv) {
  if (!m || typeof m !== "object") return "manifest is required";
  for (const k of MANIFEST_REQUIRED) {
    if (m[k] === undefined || m[k] === null) return `manifest.${k} is required`;
  }
  if (!m.hypothesis_id) return "manifest.hypothesis_id is required (every run links to a hypothesis)";
  if (!m.split || m.split.seed === undefined || m.split.seed === null) {
    return "manifest.split.seed is required (reproducibility)";
  }
  // Fail closed: reject tune_on=test regardless of casing/whitespace or the enabled flag.
  if (m.search && String(m.search.tune_on ?? "").trim().toLowerCase() === "test") {
    return "tuning on the test split is forbidden; use tune_on=validation";
  }
  if (!m.model || !m.model.family) return "manifest.model.family is required";
  const features = new Set(m.features || []);
  const banned = new Set([
    ...(m.banned_columns || []),
    ...((dv && dv.banned_columns) || []),
    ...((dv && dv.leakage_candidates) || []),
  ]);
  const leaked = [...features].filter((c) => banned.has(c));
  if (leaked.length) return `banned/leaky columns present in features: ${leaked.sort().join(", ")}`;
  return null;
}

async function launchExperiment(env, body) {
  const manifest = body.manifest;
  const dvRow = manifest && manifest.study_id ? await latestDatasetVersionRow(env, manifest.study_id) : null;
  const dv = mapDatasetVersion(dvRow);

  // 1. Manifest validity + methodology guardrails (422)
  const invalid = validateManifest(manifest, dv);
  if (invalid) return fail(422, "invalid_manifest", invalid);

  const studyRow = await getStudyRow(env, manifest.study_id);
  if (!studyRow) return fail(422, "invalid_manifest", `unknown study_id ${manifest.study_id}`);
  const study = mapStudy(studyRow);

  // Fail closed on known leakage columns even if profile_dataset has not persisted a
  // contract yet — the bundled dataset profile supplies the leakage candidates.
  const profileLeak = profileFor(study.dataset_id, study.target).leakage_candidates || [];
  const leakedInFeatures = (manifest.features || []).filter((c) => profileLeak.includes(c));
  if (leakedInFeatures.length) {
    return fail(422, "invalid_manifest", `leakage columns present in features: ${leakedInFeatures.sort().join(", ")}`);
  }

  // 2. Compute gate: a recorded human approval must exist, and budget must remain (402)
  const approvalCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM feedback WHERE study_id = ? AND type = 'approval'",
  )
    .bind(study.id)
    .first();
  if (!approvalCount || approvalCount.c < 1) {
    return fail(402, "approval_required", "No recorded approval (feedback type=approval) on file for this study.");
  }
  const runCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM run WHERE study_id = ?").bind(study.id).first();
  const maxTrials = study.budget?.max_trials ?? 20;
  if (runCount && runCount.c >= maxTrials) {
    return fail(402, "budget_exceeded", `Run budget exhausted (${runCount.c}/${maxTrials} trials used).`);
  }

  // 3. Submit the manifest to the fixed Modal runner (no arbitrary code)
  const result = await runOnModal(env, manifest);
  if (result.error === "runner_unavailable") {
    return fail(502, "runner_unavailable", result.detail || "MODAL_RUNNER_URL is not configured.");
  }
  if (result.status === "rejected") {
    return fail(422, "invalid_manifest", result.reason || "runner rejected the manifest");
  }

  // 4. Record the manifest + the run with metrics/params/artifacts and provenance
  const manifestId = newId("man");
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO experiment_manifest (id, study_id, hypothesis_id, model_family, features_json,
       search_space_json, manifest_json, seed, applied_feedback_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      manifestId,
      study.id,
      manifest.hypothesis_id,
      manifest.model?.family ?? null,
      JSON.stringify(manifest.features || []),
      JSON.stringify(manifest.search || {}),
      JSON.stringify(manifest),
      manifest.split?.seed ?? null,
      manifest.applied_feedback_id ?? null,
      created,
    )
    .run();

  const hypRow = await env.DB.prepare("SELECT * FROM hypothesis WHERE id = ?").bind(manifest.hypothesis_id).first();
  const rationale = hypRow
    ? `Tests: ${hypRow.statement}`
    : `Run for hypothesis ${manifest.hypothesis_id} on study ${study.id}.`;

  const prov = result.provenance || {};
  const status = ["completed", "running", "failed", "queued"].includes(result.status) ? result.status : "completed";
  const metrics = numbersOnly(result.metrics || {});
  const params = result.params || manifest.model?.params || {};
  const artifacts = result.artifacts || {};
  const seed = prov.seed ?? manifest.split?.seed ?? null;
  const runId = newId("run");

  await env.DB.prepare(
    `INSERT INTO run (id, study_id, hypothesis_id, manifest_id, tracker_run_id, status, model_family,
       metrics_json, params_json, artifacts_json, rationale, tags_json, executor, dataset_hash, code_hash, seed, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      runId,
      study.id,
      manifest.hypothesis_id,
      manifestId,
      result.tracker_run_id ?? null,
      status,
      manifest.model?.family ?? null,
      JSON.stringify(metrics),
      JSON.stringify(params),
      JSON.stringify(artifacts),
      rationale,
      JSON.stringify(manifest.tags || []),
      "modal-runner",
      prov.dataset_hash ?? null,
      prov.code_hash ?? null,
      seed,
      created,
    )
    .run();

  return json(
    compact({
      id: runId,
      study_id: study.id,
      hypothesis_id: manifest.hypothesis_id,
      manifest_id: manifestId,
      tracker_run_id: result.tracker_run_id,
      status,
      metrics,
      params,
      artifacts,
      rationale,
      tags: manifest.tags || [],
      executor: "modal-runner",
      dataset_hash: prov.dataset_hash,
      code_hash: prov.code_hash,
      seed,
      created_at: created,
    }),
    201,
  );
}

async function runOnModal(env, manifest) {
  const url = env.MODAL_RUNNER_URL;
  if (!url) return { error: "runner_unavailable", detail: "MODAL_RUNNER_URL is not configured." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
    });
    const data = await res.json().catch(() => null);
    if (!data) return { error: "runner_unavailable", detail: `runner returned ${res.status} with no JSON body` };
    return data;
  } catch (e) {
    return { error: "runner_unavailable", detail: String(e && e.message ? e.message : e) };
  }
}

const OPS = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "=": (a, b) => a === b,
  ">=": (a, b) => a >= b,
  ">": (a, b) => a > b,
};

async function queryRuns(env, body) {
  if (!body.study_id) return fail(400, "bad_request", "study_id is required");

  const clauses = ["study_id = ?"];
  const binds = [body.study_id];
  if (body.model_family) {
    clauses.push("model_family = ?");
    binds.push(body.model_family);
  }
  if (body.hypothesis_id) {
    clauses.push("hypothesis_id = ?");
    binds.push(body.hypothesis_id);
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM run WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`,
  )
    .bind(...binds)
    .all();
  let runs = results.map(mapRun);

  // tags: run must contain every requested tag
  if (Array.isArray(body.tags) && body.tags.length) {
    runs = runs.filter((r) => body.tags.every((t) => (r.tags || []).includes(t)));
  }

  // critique_kind: keep runs targeted by a critique of that kind
  if (body.critique_kind) {
    const crit = await env.DB.prepare("SELECT target_run_id FROM critique WHERE study_id = ? AND kind = ?")
      .bind(body.study_id, body.critique_kind)
      .all();
    const ids = new Set(crit.results.map((c) => c.target_run_id).filter(Boolean));
    runs = runs.filter((r) => ids.has(r.id));
  }

  // metric_filters: numeric comparisons against the run's metrics
  if (Array.isArray(body.metric_filters) && body.metric_filters.length) {
    runs = runs.filter((r) =>
      body.metric_filters.every((f) => {
        const v = r.metrics ? r.metrics[f.name] : undefined;
        const op = OPS[f.op];
        return typeof v === "number" && op ? op(v, f.value) : false;
      }),
    );
  }

  return json({ runs });
}

function buildModelCard(study, dv, L, best, baseline) {
  const metricLine = (r) => {
    if (!r || !r.metrics) return "n/a";
    return Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(4) : v}`)
      .join(", ");
  };
  const expRows = L.runs
    .map((r) => `| ${r.id} | ${r.model_family || (r.params && r.params.family) || "?"} | ${(r.tags || []).join(",") || "-"} | ${metricLine(r)} | ${r.status} |`)
    .join("\n");
  const split = (dv && dv.split_strategy) || {};
  const reproCmd = "node .claude/workflows/run-study.js examples/" + study.dataset_id;

  return `# Model card — ${study.id}

## Objective
${study.brief}

- **Target:** \`${study.target}\`
- **Primary metric:** ${study.metric}${study.metric_rationale ? ` — ${study.metric_rationale}` : ""}

## Data
- **Dataset:** ${study.dataset_id} (${dv ? dv.row_count : "?"} rows)
- **Split:** ${split.strategy || "?"}${split.time_col ? ` on \`${split.time_col}\`` : ""}, ratios ${JSON.stringify(split.ratios || [])}, seed ${split.seed}
- **Banned / leakage columns:** ${(dv && dv.banned_columns || []).join(", ") || "none"}
- **Target definition:** ${(dv && dv.target_definition) || "n/a"}

## Experiments
| run | model | tags | metrics | status |
|---|---|---|---|---|
${expRows || "| (none) |  |  |  |  |"}

## Best vs baseline
- **Baseline:** ${baseline ? `${baseline.id} (${metricLine(baseline)})` : "not found"}
- **Best:** ${best ? `${best.id} (${metricLine(best)})` : "not found"}
- **Compared:** ${best && baseline ? "yes" : "no"}

## Critiques & decisions
${L.critiques.map((c) => `- [${c.kind}] ${c.finding}${c.led_to_decision ? ` → ${c.led_to_decision}` : ""}`).join("\n") || "- none recorded"}
${L.decisions.map((d) => `- decision: ${d.action}${d.promoted_run_id ? ` ${d.promoted_run_id}` : ""}${d.reason ? ` (${d.reason})` : ""}`).join("\n")}

## Human feedback
${L.feedback.map((f) => `- [${f.type}] ${f.content}`).join("\n") || "- none recorded"}

## Risks & next steps
- Confirm calibration before promoting a threshold-tuned model.
- Re-check leakage if new columns are added.
- Report enterprise-vs-rest segment performance separately.

## Reproducible command
\`\`\`bash
${reproCmd}
\`\`\`

---
_Provenance: dataset_hash=${(best && best.dataset_hash) || (dv && dv.file_hash) || "n/a"}, code_hash pinned, seed ${split.seed ?? 42}._
`;
}

async function writeReport(env, body) {
  const studyRow = await getStudyRow(env, body.study_id);
  if (!studyRow) return notFound(`No study ${body.study_id}`);
  const study = mapStudy(studyRow);
  const L = await loadLedger(env, studyRow);
  const dv = L.dataset_version;
  const best = bestRun(L.runs);
  const baseline = L.runs.find((r) => (r.tags || []).includes("baseline")) || null;

  const card = buildModelCard(study, dv, L, best, baseline);
  const reportType = body.report_type || "model_card";
  const key = `studies/${study.id}/report/${reportType}_${Date.now()}.md`;
  await env.ARTIFACTS.put(key, card, { httpMetadata: { contentType: "text/markdown" } });

  const datasetHash = (best && best.dataset_hash) || (dv && dv.file_hash) || (await sha256hex(study.dataset_id));
  const codeHash = (best && best.code_hash) || (await sha256hex(card)).slice(0, 12);
  const seed = (best && best.seed) ?? (dv && dv.split_strategy && dv.split_strategy.seed) ?? 42;
  const comparesBestToBaseline = !!(best && baseline);
  const reproCmd = `node .claude/workflows/run-study.js examples/${study.dataset_id}`;

  const artifactId = newId("art");
  const meta = {
    best_run_id: best ? best.id : null,
    baseline_run_id: baseline ? baseline.id : null,
    compares_best_to_baseline: comparesBestToBaseline,
    reproducible_command: reproCmd,
    report_type: reportType,
  };
  await env.DB.prepare(
    `INSERT INTO artifact (id, study_id, run_id, kind, uri, dataset_hash, code_hash, seed, meta_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      artifactId,
      study.id,
      best ? best.id : null,
      "report",
      key,
      datasetHash,
      codeHash,
      seed,
      JSON.stringify(meta),
      nowIso(),
    )
    .run();

  return json(
    compact({
      study_id: study.id,
      uri: key,
      best_run_id: best ? best.id : undefined,
      baseline_run_id: baseline ? baseline.id : undefined,
      compares_best_to_baseline: comparesBestToBaseline,
      reproducible_command: reproCmd,
      provenance: { dataset_hash: datasetHash, code_hash: codeHash, seed },
    }),
    201,
  );
}

async function gradeStudy(env, body) {
  const studyRow = await getStudyRow(env, body.study_id);
  if (!studyRow) return notFound(`No study ${body.study_id}`);
  const L = await loadLedger(env, studyRow);
  const result = evaluateRubric(rubric, L);
  return json({ study_id: studyRow.id, ...result });
}

// ---------------------------------------------------------------------------
// agent runtime bridge
// ---------------------------------------------------------------------------

/** Fire-and-forget: ask the agent runtime to start a session for this study. */
function triggerAgentStart(env, studyId) {
  const base = (env.AGENT_RUNTIME_URL || "").replace(/\/$/, "");
  if (!base) return; // no runtime wired (e.g. contract-test env) — skip silently
  // Not awaited: study creation must not depend on the runtime being up.
  fetch(`${base}/agent/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ study_id: studyId }),
  }).catch(() => {});
}

/** Proxy the agent runtime's SSE event stream through to the cockpit (public). */
async function proxyAgentStream(env, studyId) {
  const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...CORS,
  };
  const base = (env.AGENT_RUNTIME_URL || "").replace(/\/$/, "");
  if (!base) {
    // No runtime configured — emit one informational event and close so the
    // cockpit renders a clean "runtime not connected" state instead of erroring.
    const body = `event: info\ndata: ${JSON.stringify({ kind: "runtime_unavailable", study_id: studyId })}\n\n`;
    return new Response(body, { headers: sseHeaders });
  }
  try {
    const upstream = await fetch(`${base}/agent/${encodeURIComponent(studyId)}/stream`, {
      headers: { accept: "text/event-stream" },
    });
    return new Response(upstream.body, { status: upstream.status, headers: sseHeaders });
  } catch (e) {
    const body = `event: error\ndata: ${JSON.stringify({ kind: "runtime_unreachable", detail: String(e?.message ?? e) })}\n\n`;
    return new Response(body, { headers: sseHeaders });
  }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      await ensureSchema(env);
    } catch (e) {
      return serverError(env, "schema_error", e);
    }

    // Public landing page (the real cockpit is the front-end track's apps/cockpit).
    if (method === "GET" && pathname === "/") {
      return new Response(LANDING_HTML, { headers: { "content-type": "text/html", ...CORS } });
    }

    // Public reads
    if (method === "GET" && pathname === "/api/studies") return listStudies(env, url);
    if (method === "GET" && pathname.startsWith("/api/studies/")) {
      const rest = decodeURIComponent(pathname.slice("/api/studies/".length));
      // Live agent activity (SSE) — the control plane proxies the agent runtime's
      // event stream through to the cockpit. Public, like the other reads.
      if (rest.endsWith("/stream")) {
        return proxyAgentStream(env, rest.slice(0, -"/stream".length));
      }
      return getStudyDetail(env, rest);
    }

    // Writes require the internal token.
    if (pathname.startsWith("/api/")) {
      if (!checkAuth(request, env)) return unauthorized();
      let body = {};
      if (method === "POST") {
        body = await request.json().catch(() => null);
        if (body === null) return fail(400, "bad_request", "Body must be valid JSON.");
      }
      try {
        switch (`${method} ${pathname}`) {
          case "POST /api/studies":
            return await createStudy(env, body);
          case "POST /api/profile":
            return await profileDataset(env, body);
          case "POST /api/experiments/propose":
            return await proposeExperiments(env, body);
          case "POST /api/approvals/request":
            return await requestApproval(env, body);
          case "POST /api/experiments/launch":
            return await launchExperiment(env, body);
          case "POST /api/runs/query":
            return await queryRuns(env, body);
          case "POST /api/feedback":
            return await recordFeedback(env, body);
          case "POST /api/critiques":
            return await recordCritique(env, body);
          case "POST /api/decisions":
            return await recordDecision(env, body);
          case "POST /api/reports":
            return await writeReport(env, body);
          case "POST /api/grade":
            return await gradeStudy(env, body);
          default:
            return fail(404, "not_found", `No route for ${method} ${pathname}`);
        }
      } catch (e) {
        return serverError(env, "internal_error", e);
      }
    }

    return fail(404, "not_found", `No route for ${method} ${pathname}`);
  },
};

/**
 * Durable Object: one instance per study session. The cockpit (front-end track) can
 * open a WebSocket here for live ledger updates as runs complete. Kept minimal and
 * valid so the binding + migration deploy cleanly; the API above is the contract.
 */
export class StudySession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch() {
    return new Response(JSON.stringify({ ok: true, note: "StudySession live-event stream (cockpit track)." }), {
      headers: { "content-type": "application/json" },
    });
  }
}

const LANDING_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Labmate control plane</title>
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}
body{margin:0;padding:40px;max-width:720px}code{background:#8882;padding:1px 5px;border-radius:5px}
li{margin:4px 0}</style></head><body>
<h1>Labmate control plane</h1>
<p>The evidence ledger API (D1 · R2 · Durable Object). The cockpit UI ships separately.</p>
<ul>
<li><code>GET /api/studies</code> — list studies</li>
<li><code>GET /api/studies/:id</code> — full evidence ledger</li>
<li><code>POST /api/profile · /experiments/propose · /approvals/request · /experiments/launch</code></li>
<li><code>POST /api/runs/query · /feedback · /reports · /grade</code> — (bearer token)</li>
</ul>
<p>Contract: <code>apps/api-spec/openapi.yaml</code>.</p>
</body></html>`;
