/**
 * Labmate Cloudflare Worker — the control plane API for the evidence ledger.
 *
 * One Worker, backed by D1 (the ledger), R2 (artifacts), and a Durable Object
 * (live study session). It is the single contract both clients hit: the MCP server
 * (Claude's semantic tools) and the cockpit (the human's mission control). Every
 * route here matches apps/api-spec/openapi.yaml.
 *
 * Routes (all POST require the internal bearer token; the GET reads are public):
 *   POST /api/studies               create_study           -> 201 { id, status }
 *   GET  /api/studies               list studies (public)  -> 200 { studies }
 *   GET  /api/studies/:id           study detail (public)  -> 200 StudyDetail | 404
 *   GET  /api/studies/:id/report    latest model card (public) -> 200 Report | 404
 *   GET  /api/studies/:id/grade     grade study (public read)  -> 200 GradeResult | 404
 *   GET  /api/studies/:id/stream    live agent SSE (public) -> 200 text/event-stream
 *   POST /api/studies/:id/message   suggest_change          -> 202 { status } | 503
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
import { profileFor, profileCsv, hypothesisLibrary, generatedHypothesisLibrary } from "./profiles.js";
import { buildContracts, inferTaskType } from "./contracts.js";
import { evaluateRubric } from "./grade.js";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Allowlist of the two known cockpit hosts. We keep `*` for the origin because the
// API is bearer-only (no cookies are read or set), so a permissive CORS origin does
// not expose any ambient-authority credential — the bearer token must be supplied
// explicitly by the caller. The known hosts are kept for documentation and for any
// future tightening (flip to origin reflection here if cookies are ever introduced).
const ALLOWED_ORIGINS = ["https://labmate.amazingvince.com", "https://amazingvince.com"];

/**
 * Build CORS headers for a request. Origin stays `*` (bearer-only API, no cookies),
 * but allow-headers REFLECTS the browser's Access-Control-Request-Headers so a
 * preflight never fails on a header the client legitimately sends. Falls back to the
 * known set when the request omits the hint.
 */
function corsHeaders(request) {
  const reqHeaders =
    (request && request.headers && request.headers.get("access-control-request-headers")) ||
    "authorization,content-type";
  // Echo a known cockpit origin back explicitly (clearer than `*`, and lets us add
  // `Vary: Origin`); fall back to `*` for any other caller. Bearer-only, no cookies, so
  // `*` remains safe — there is no ambient credential to protect.
  const origin = request && request.headers && request.headers.get("origin");
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": reqHeaders,
    "access-control-max-age": "86400",
    "vary": "Origin, Access-Control-Request-Headers",
  };
}

// Static CORS for response paths that don't carry the originating request (the
// allow-headers value is only consulted on preflights, which use corsHeaders()).
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
const writesDisabled = () =>
  fail(503, "writes_disabled", "Server internal token is unset or too short; writes are disabled. Reads remain public.");

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

// Minimum acceptable length for the shared internal token. A token shorter than this
// (or absent) is treated as misconfiguration: writes are refused (503) rather than
// silently falling back to a guessable default. Reads stay public regardless.
const MIN_TOKEN_LEN = 24;
let _warnedWeakToken = false;

/**
 * Is the configured internal token usable for authenticating writes? The token must be
 * present and at least MIN_TOKEN_LEN chars. We NEVER hardcode a default — a missing or
 * weak token means writes are refused, not allowed. Logs a one-line warning the first
 * time a write path observes a misconfigured token.
 */
function serverTokenUsable(env) {
  const tok = env && env.LABMATE_INTERNAL_TOKEN;
  const ok = typeof tok === "string" && tok.length >= MIN_TOKEN_LEN;
  if (!ok && !_warnedWeakToken) {
    _warnedWeakToken = true;
    console.warn(
      `[labmate] LABMATE_INTERNAL_TOKEN is missing or <${MIN_TOKEN_LEN} chars; refusing all writes (503). Set it with: wrangler secret put LABMATE_INTERNAL_TOKEN`,
    );
  }
  return ok;
}

/**
 * Require the shared internal token on writes. NOTE: the human checkpoint (approval)
 * is enforced out-of-band — the cockpit is where a human approves, which records a
 * feedback(type=approval); the MCP server and cockpit share LABMATE_INTERNAL_TOKEN by
 * design (docs/ENV.md). This token authenticates the caller, not the human approval.
 *
 * Returns false unless the SERVER token is usable (present + >= MIN_TOKEN_LEN) AND the
 * caller presents a matching bearer. The usability gate is also checked on the write
 * path to return a clearer 503 (vs an opaque 401) when the server is misconfigured.
 */
function checkAuth(request, env) {
  if (!serverTokenUsable(env)) return false;
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return !!(token && timingSafeEqual(token, env.LABMATE_INTERNAL_TOKEN));
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

// Additive, idempotent column migrations for DBs created before a column existed.
// SQLite has no "ADD COLUMN IF NOT EXISTS"; each is run independently and a
// "duplicate column" error is swallowed, so this never aborts the base schema batch.
const ADDITIVE_MIGRATIONS = [
  "ALTER TABLE run ADD COLUMN applied_feedback_id TEXT",
  // Slice 2: the generated PER-STUDY data + metric contract, persisted on the
  // dataset_version row so it is part of the reproducible ledger (not just a doc).
  "ALTER TABLE dataset_version ADD COLUMN data_contract_json TEXT",
  "ALTER TABLE dataset_version ADD COLUMN metric_contract_json TEXT",
];

async function applyAdditiveMigrations(env) {
  for (const sql of ADDITIVE_MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      // Column already exists (or table not yet created) — additive migrations are best-effort.
    }
  }
}

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

/**
 * Self-apply schema.sql once per isolate. Wrangler migrations remain authoritative —
 * this is a convenience for `wrangler dev` / fresh DBs. It is BEST-EFFORT: a transient
 * DDL failure must NOT take down public reads. We memoize the successful promise; on
 * failure we clear the memo (so a later write path can retry) and return false rather
 * than throwing into read handlers.
 *
 * @returns {Promise<boolean>} true if the schema batch succeeded this isolate.
 */
function ensureSchema(env) {
  if (!_schemaReady) {
    const statements = splitSql(schemaSQL).map((s) => env.DB.prepare(s));
    _schemaReady = env.DB.batch(statements)
      .then(() => applyAdditiveMigrations(env))
      .then(() => true)
      .catch((e) => {
        _schemaReady = null; // allow a retry on the next request
        console.warn("[labmate] schema bootstrap failed (best-effort):", e && e.message ? e.message : e);
        return false;
      });
  }
  return _schemaReady;
}

/**
 * Hard schema requirement for write paths. Awaits ensureSchema and, if it failed,
 * forces a single synchronous retry that DOES surface the error to the caller so a
 * write never proceeds against a missing schema. Throws on a hard failure.
 */
async function requireSchema(env) {
  const ok = await ensureSchema(env);
  if (ok) return;
  // ensureSchema cleared its memo on failure; retry once and surface any error.
  const statements = splitSql(schemaSQL).map((s) => env.DB.prepare(s));
  _schemaReady = env.DB.batch(statements)
    .then(() => applyAdditiveMigrations(env))
    .then(() => true)
    .catch((e) => {
      _schemaReady = null;
      throw e;
    });
  await _schemaReady;
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
  const dataContract = parse(row.data_contract_json);
  const metricContract = parse(row.metric_contract_json);
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
    // The generated PER-STUDY contracts (data + metric). compact() drops them when null
    // (old dataset_version rows written before slice 2) — existing consumers unaffected.
    contracts:
      dataContract || metricContract
        ? compact({ data: dataContract, metric: metricContract })
        : undefined,
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
    applied_feedback_id: row.applied_feedback_id, // which human feedback shaped this run (C11)
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

/** Pick the best completed run by the first available primary metric (higher is better).
 *  When `opts.excludeBaseline` is set, runs tagged "baseline" are skipped so the report's
 *  "best" reflects a TUNED model, not the baseline (C4). */
function bestRun(runs, opts = {}) {
  const completed = runs.filter((r) => r.status === "completed");
  const pool = opts.excludeBaseline
    ? completed.filter((r) => !(r.tags || []).includes("baseline"))
    : completed;
  let best = null;
  let bestScore = -Infinity;
  for (const r of pool) {
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

async function createStudy(env, body, ctx) {
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
  // Kick the agent runtime to start a Managed Agents session for this study. We do
  // NOT block the create response on the runtime being up — but the kick MUST still
  // run after we return. In a Cloudflare Worker a bare un-awaited fetch is killed the
  // moment this handler's response resolves, so the kick is registered with
  // ctx.waitUntil(...) (see triggerAgentStart) to keep it alive past the response.
  triggerAgentStart(env, id, ctx);
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

/**
 * Where the Modal runner fetches the study's CSV. Derived from the study's
 * dataset_id and an optional LABMATE_DATASET_BASE (an R2/HTTPS base the runner can
 * read). The agent gets this back from profile_dataset and echoes it on the
 * manifest; launchExperiment also default-fills it so a manifest may omit it.
 */
function datasetUriFor(env, study) {
  const base = (env.LABMATE_DATASET_BASE || "").replace(/\/$/, "");
  const key = `${study.dataset_id}.csv`;
  return base ? `${base}/${key}` : key;
}

/** Serve a dataset CSV from R2 (public) under datasets/<name>. `name` is e.g.
 *  "sla_tickets.csv"; sanitized to a flat filename to prevent traversal. */
async function serveDataset(env, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || !env.ARTIFACTS) return notFound("dataset not found");
  const obj = await env.ARTIFACTS.get(`datasets/${safe}`);
  if (!obj) return notFound(`dataset ${safe} not found`);
  return new Response(obj.body, {
    headers: { "content-type": "text/csv", "cache-control": "public, max-age=300", ...CORS },
  });
}

/**
 * Upload a dataset CSV (token-gated write). Accepts either a raw `text/csv` request
 * body or JSON `{ dataset_id?, csv }`. Stores the CSV to R2 at datasets/{dataset_id}.csv,
 * upserts a row in the `dataset` catalog (id, content hash, row count, profile), and
 * returns `{ dataset_id, profile }`. Idempotent on a given dataset_id (re-upload
 * overwrites the R2 object and updates the catalog row). The profile is the REAL
 * profiling result (profileCsv) — a target may be supplied to drive the leakage
 * separation heuristic, but is optional (name-pattern leakage still applies).
 */
async function uploadDataset(env, _body, request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  const qs = new URL(request.url).searchParams;
  let csv;
  let datasetId = qs.get("dataset_id") || null;
  let target = qs.get("target") || null;
  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.csv !== "string") {
      return fail(400, "bad_request", "Provide a CSV via a text/csv body or JSON { csv }.");
    }
    csv = body.csv;
    datasetId = body.dataset_id || datasetId;
    target = body.target || target;
  } else {
    // Raw text/csv (or text/plain) body; dataset_id/target come from the query string.
    csv = await request.text();
  }
  if (typeof csv !== "string" || csv.trim().length === 0) {
    return fail(400, "bad_request", "CSV body is empty.");
  }
  // Assign an id if none was given; sanitize a provided one to a flat, R2-safe key.
  if (datasetId) {
    datasetId = String(datasetId).replace(/[^a-zA-Z0-9._-]/g, "");
    if (!datasetId) return fail(400, "bad_request", "dataset_id contains no usable characters.");
  } else {
    datasetId = newId("dataset");
  }

  const profile = profileCsv(csv, { target, datasetId });
  if (!profile.columns.length) {
    return fail(400, "bad_request", "Could not parse any columns from the CSV.");
  }
  const contentHash = await sha256hex(csv);

  if (env.ARTIFACTS) {
    await env.ARTIFACTS.put(`datasets/${datasetId}.csv`, csv, {
      httpMetadata: { contentType: "text/csv" },
    });
  }

  // Upsert the catalog row (idempotent on dataset_id). ensureSchema created `dataset`.
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO dataset (id, source, content_hash, row_count, target, profile_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       content_hash = excluded.content_hash,
       row_count    = excluded.row_count,
       target       = excluded.target,
       profile_json = excluded.profile_json,
       updated_at   = excluded.updated_at`,
  )
    .bind(
      datasetId,
      "uploaded",
      contentHash,
      profile.row_count,
      target,
      JSON.stringify(profile),
      now,
      now,
    )
    .run();

  return json({ dataset_id: datasetId, profile }, 201);
}

/**
 * Resolve a dataset profile for a study. Priority:
 *   1. an uploaded CSV in R2 at datasets/{dataset_id}.csv → REAL profiling (profileCsv);
 *   2. a bundled known dataset (e.g. sla_tickets) with no uploaded CSV → the committed
 *      golden profile, so the demo stays deterministic and offline;
 *   3. otherwise the minimal generic profile.
 * Returns { profile, fileHash } where fileHash hashes the actual CSV bytes when one was
 * read, else the structural profile (unchanged for the bundled golden path).
 */
async function resolveProfile(env, study) {
  const safe = String(study.dataset_id).replace(/[^a-zA-Z0-9._-]/g, "");
  let csvText = null;
  if (safe && env.ARTIFACTS) {
    try {
      const obj = await env.ARTIFACTS.get(`datasets/${safe}.csv`);
      if (obj) csvText = await obj.text();
    } catch {
      // R2 miss / unbound — fall through to the bundled or generic profile.
    }
  }
  if (csvText !== null) {
    const profile = profileCsv(csvText, { target: study.target, datasetId: study.dataset_id });
    // Carry a real target definition over from the bundled known-good profile when it
    // matches (keeps the golden path's documented definition even if re-uploaded).
    const known = profileFor(study.dataset_id, study.target);
    if (!profile.target_definition && known.target === study.target && known.target_definition) {
      profile.target_definition = known.target_definition;
    }
    const fileHash = await sha256hex(csvText);
    // `source: "csv"` tells callers (proposeExperiments) this is a REAL uploaded dataset,
    // so they can generate dataset-agnostic hypotheses instead of the bundled library.
    return { profile, fileHash, source: "csv" };
  }
  const profile = profileFor(study.dataset_id, study.target);
  const fileHash = await sha256hex(
    JSON.stringify({ d: profile.dataset_id, n: profile.row_count, c: profile.columns, s: profile.split }),
  );
  // No uploaded CSV: either a bundled known-good profile (has profiled columns, e.g.
  // sla_tickets) or the minimal generic fallback (no columns). Callers that need a real
  // profile to generate hypotheses treat both as "not an uploaded dataset".
  const source = (profile.columns || []).length ? "bundled" : "generic";
  return { profile, fileHash, source };
}

async function profileDataset(env, body) {
  const studyRow = await getStudyRow(env, body.study_id);
  if (!studyRow) return notFound(`No study ${body.study_id}`);
  const study = mapStudy(studyRow);
  const { profile, fileHash } = await resolveProfile(env, study);
  const constraints = parse(studyRow.constraints_json) || {};
  const leakage = profile.leakage_candidates || [];
  const banned = [...new Set([...(constraints.banned_columns || []), ...leakage])];
  const split = profile.split;

  // Generate the PER-STUDY data + metric contract deterministically from the study
  // config + resolved profile. This is the "contract is the product" artifact — it
  // works for ANY uploaded dataset, not just the committed golden sla_tickets docs.
  const contracts = buildContracts(study, profile, constraints);

  const id = newId("ds");
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO dataset_version (id, study_id, file_hash, row_count, columns_json, target_definition,
       split_strategy, split_json, seed, leakage_candidates_json, banned_columns_json,
       data_contract_json, metric_contract_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      JSON.stringify(contracts.data),
      JSON.stringify(contracts.metric),
      created,
    )
    .run();

  // Persist the generated contract as a study-scoped R2 artifact so it lives in the
  // ledger alongside reports/plots (best-effort — never block the DB write on R2).
  if (env.ARTIFACTS) {
    try {
      await env.ARTIFACTS.put(
        `studies/${study.id}/contract/data_metric_contract.json`,
        JSON.stringify({ dataset_version_id: id, file_hash: fileHash, ...contracts }, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      );
    } catch {
      // R2 unbound / transient — the contract is still persisted on the dataset_version row.
    }
  }

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
      // The generated per-study contract (data + metric) — the cockpit and report read this.
      contracts,
      // The agent copies this onto launch_experiment manifests so the runner can
      // fetch the CSV (launch also default-fills it if the manifest omits it).
      dataset_uri: datasetUriFor(env, study),
    }),
    200,
  );
}

async function proposeExperiments(env, body) {
  const studyRow = await getStudyRow(env, body.study_id);
  if (!studyRow) return notFound(`No study ${body.study_id}`);
  const study = mapStudy(studyRow);
  // Resolve the REAL profile: an uploaded CSV (source "csv") or the bundled/generic
  // profile. Hypothesis proposal must be derived from the ACTUAL dataset, not always
  // the sla_tickets library.
  const { profile, source } = await resolveProfile(env, study);

  // The agent reasons in hypotheses and the human approves them (the product
  // premise) — so when the caller supplies hypotheses, persist THOSE and return
  // their ids. Fall back to a seeded/generated library only when none are supplied
  // (e.g. a bare {study_id}). Leaky features are NOT rejected here; the launch-time
  // 422 is the enforcement point (and the planted-leakage self-correction moment).
  let cards;
  if (Array.isArray(body.hypotheses) && body.hypotheses.length) {
    cards = body.hypotheses
      .filter((h) => h && h.statement)
      .map((h) => ({
        statement: h.statement,
        rationale: h.rationale,
        model_family: h.model_family,
        features: Array.isArray(h.features) ? h.features : [],
        expected_outcome: h.expected_outcome,
      }));
  } else {
    let n = parseInt(body.n ?? 6, 10);
    if (!Number.isFinite(n) || n < 1) n = 6;
    if (n > 12) n = 12;
    if (source === "csv") {
      // UPLOADED dataset: generate baseline-first, task-appropriate cards from the real
      // profile + inferred task type. Respects the study's target + primary metric and
      // uses only safe (non-leakage, non-banned) features.
      const constraints = study.constraints || {};
      const taskType = inferTaskType(study, profile);
      const metric =
        constraints.primary_metric || study.metric || (taskType === "regression" ? "rmse" : "recall");
      cards = generatedHypothesisLibrary(profile, {
        taskType,
        target: study.target || profile.target,
        metric,
        bannedColumns: constraints.banned_columns || [],
      }).slice(0, n);
    } else {
      // Bundled (sla_tickets) or generic / no uploaded CSV: keep the existing seeded
      // library exactly (the golden path + its tests depend on these cards verbatim).
      cards = hypothesisLibrary(profile).slice(0, n);
    }
  }
  // C3 — dedupe by (study_id, statement): skip cards whose statement already exists
  // for this study (re-proposing the same card must not duplicate the hypothesis).
  const existingRows = await env.DB.prepare("SELECT statement FROM hypothesis WHERE study_id = ?")
    .bind(study.id)
    .all();
  const seenStatements = new Set((existingRows.results || []).map((r) => r.statement));

  const created = nowIso();
  const out = [];
  const stmts = [];
  for (const card of cards) {
    if (!card.statement || seenStatements.has(card.statement)) continue; // dedupe within batch + against existing
    seenStatements.add(card.statement);
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

/** A free-text "stop using X" only mutates the contract when X is a plausible column
 *  name (a single snake_case / identifier token), never an arbitrary English word.
 *  Returns the normalized (lowercased, trimmed) column token, or false. */
function looksLikeColumn(tok) {
  if (typeof tok !== "string") return false;
  const t = tok.trim().replace(/[.,;:"'`)]+$/, "").replace(/^["'`(]+/, "");
  return /^[a-z][a-z0-9_]{1,39}$/i.test(t) ? t.toLowerCase() : false;
}

/** Lightweight natural-language -> constraint parse for free-text notes. Parses for
 *  both "note" and "human_feedback" types (the cockpit and MCP use the latter).
 *
 *  Returns a parsed-constraints object whose keys signal UNAMBIGUOUS intent:
 *  - primary_metric: an explicit "<metric> matters more / prioritize <metric>" statement
 *  - guardrail:      an explicit false-positive-rate bound (percent OR decimal)
 *  - banned_columns: explicit "stop using / don't use / ban / drop <column>" intents
 *  Vague encouragement ("looks good, keep going") yields undefined → no contract change. */
function parseConstraints(content, type) {
  if (type !== "note" && type !== "human_feedback") return undefined;
  const t = (content || "").toLowerCase();
  const c = {};

  // ---- primary metric (explicit "<metric> matters more / prioritize <metric>") ----
  const metricToken = (s) => {
    if (/\brecall\b/.test(s)) return "recall";
    if (/\bprecision\b/.test(s)) return "precision";
    if (/\b(roc[ _-]?auc|auc[ _-]?roc)\b/.test(s)) return "roc_auc";
    if (/\b(pr[ _-]?auc|auc[ _-]?pr|average precision)\b/.test(s)) return "pr_auc";
    if (/\brmse\b/.test(s)) return "rmse";
    if (/\bmae\b/.test(s)) return "mae";
    if (/\br2\b|r\^2|r-squared/.test(s)) return "r2";
    return null;
  };
  // "<X> matters more than <Y>" / "<X> over <Y>" / "prioritize <X> over <Y>": the
  // SUBJECT (the side before "more than/over/rather than/instead of") is the choice.
  const versus = t.split(/\bmore important than\b|\bmatters? more than\b|\bover\b|\brather than\b|\binstead of\b/);
  if (versus.length >= 2) {
    const subj = metricToken(versus[0]);
    if (subj) c.primary_metric = subj;
  }
  if (!c.primary_metric) {
    const priorityCtx = /(matter|priorit|focus on|optimi[sz]e for|care (?:more )?about|more important)/;
    if (priorityCtx.test(t)) {
      const tok = metricToken(t);
      if (tok) c.primary_metric = tok;
    }
  }

  // ---- false-positive-rate guardrail (percent OR decimal) ----
  if (/(false[ _-]?positive|fpr|false[ _-]?alarm)/.test(t)) {
    let bound = null;
    const pct = t.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (pct) {
      const v = parseFloat(pct[1]) / 100;
      if (Number.isFinite(v) && v >= 0 && v <= 1) bound = v;
    } else {
      // decimal form: "fpr <= 0.10", "false positive rate 0.1", "fpr under 0.05"
      const dec = t.match(/(?:false[ _-]?positive[ _-]?rate|fpr)[^0-9]{0,24}(0?\.\d+)/);
      if (dec) {
        const v = parseFloat(dec[1]);
        if (Number.isFinite(v) && v >= 0 && v <= 1) bound = v;
      }
    }
    if (bound !== null) c.guardrail = `false_positive_rate <= ${bound.toFixed(2)}`;
  }

  // ---- ban intent → banned columns ("stop using X", "don't use X", "ban X", ...) ----
  const banned = [];
  const banRe =
    /(?:stop using|don'?t use|do not use|\bban\b|drop(?: the)?(?: feature| column)?|remove(?: the)?(?: feature| column)?|exclude|no longer use)\s+([a-z][a-z0-9_]{1,39})/gi;
  let m;
  while ((m = banRe.exec(t)) !== null) {
    const col = looksLikeColumn(m[1]);
    if (col && !banned.includes(col)) banned.push(col);
  }
  if (banned.length) c.banned_columns = banned;

  return Object.keys(c).length ? c : undefined;
}

/**
 * The causal core: MERGE a feedback's unambiguous constraint intent into the study's
 * enforced contract (`study.constraints`). dispatch.mjs and BOTH launch paths read
 * `study.constraints` on every launch (FPR `max_fpr`, `primary_metric`, banned columns
 * flow study→runner and the runner enforces the FPR bound), so a merge here makes
 * mid-run feedback causal for every SUBSEQUENT experiment — no agent re-read required.
 *
 * Additive + idempotent: never drops existing fields; only sets/replaces the specific
 * keys the human stated. Returns { changed, summary[] } describing what (if anything)
 * actually changed, so the caller can persist the linkage and report it. A merge that
 * produces no net change returns changed=false (so a restatement of the current
 * contract is honestly reported as a no-op).
 *
 * @param body         the inbound feedback ({ type, target_id, ... })
 * @param parsed       parsed_constraints (explicit or from parseConstraints)
 */
function mergeStudyConstraints(current, body, parsed) {
  const next = JSON.parse(JSON.stringify(current || {}));
  const summary = [];

  // (a) primary_metric — an explicit metric preference. Keep study.metric coherent is
  //     handled by the caller; here we set the constraint the launch path reads.
  const metricIntent =
    (parsed && parsed.primary_metric) ||
    (body.type === "change_metric" && typeof body.target_id === "string" ? body.target_id : null);
  if (metricIntent && next.primary_metric !== metricIntent) {
    next.primary_metric = metricIntent;
    summary.push(`primary_metric → ${metricIntent}`);
  }

  // (b) FPR guardrail — replace the matching-metric (false_positive_rate) guardrail with
  //     the human's bound; keep every OTHER guardrail untouched.
  if (parsed && typeof parsed.guardrail === "string") {
    const m = parsed.guardrail.match(/false[_\s]?positive[_\s]?rate\s*<=?\s*([0-9]*\.?[0-9]+)/i);
    if (m) {
      const bound = parseFloat(m[1]);
      const before = studyFprBound(next);
      if (Number.isFinite(bound) && before !== bound) {
        // Drop any existing FPR guardrail (string or {expr}) then add the new one.
        const others = [];
        const g = next.guardrails;
        const isFpr = (s) => typeof s === "string" && /false[_\s]?positive[_\s]?rate/i.test(s);
        if (Array.isArray(g)) {
          for (const item of g) {
            if (typeof item === "string") {
              if (!isFpr(item)) others.push(item);
            } else if (item && typeof item === "object" && typeof item.expr === "string") {
              if (!isFpr(item.expr)) others.push(item);
            } else {
              others.push(item);
            }
          }
        } else if (typeof g === "string" && !isFpr(g)) {
          others.push(g);
        }
        others.push({ expr: `false_positive_rate <= ${bound}` });
        next.guardrails = others;
        // A bare structured `guardrail` field, if present, is the FPR one — refresh it.
        if (typeof next.guardrail === "string" && isFpr(next.guardrail)) {
          next.guardrail = `false_positive_rate <= ${bound}`;
        }
        summary.push(`false_positive_rate <= ${bound}${before !== null ? ` (was ${before})` : ""}`);
      }
    }
  }

  // (c) banned columns — ban_feature (target_id) OR parsed banned_columns. Append + dedupe.
  const bans = [];
  if (body.type === "ban_feature" && typeof body.target_id === "string" && looksLikeColumn(body.target_id)) {
    bans.push(body.target_id.toLowerCase());
  }
  if (parsed && Array.isArray(parsed.banned_columns)) {
    for (const col of parsed.banned_columns) if (looksLikeColumn(col)) bans.push(col.toLowerCase());
  }
  if (bans.length) {
    const have = new Set((next.banned_columns || []).map((c) => String(c).toLowerCase()));
    const added = [];
    const list = next.banned_columns ? [...next.banned_columns] : [];
    for (const col of bans) {
      if (!have.has(col)) {
        have.add(col);
        list.push(col);
        added.push(col);
      }
    }
    if (added.length) {
      next.banned_columns = list;
      summary.push(`banned_columns += [${added.join(", ")}]`);
    }
  }

  return { next, changed: summary.length > 0, summary };
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

  // CAUSAL MERGE — when the parse carries UNAMBIGUOUS constraint intent, fold it into the
  // study's enforced contract so every SUBSEQUENT launch reads (and the runner enforces)
  // the human's bound/metric/bans. Conservative: an approval/vague note changes nothing.
  let constraintsChanged = false;
  let changeSummary = [];
  const studyRow = await getStudyRow(env, body.study_id);
  if (studyRow && body.type !== "approval") {
    const currentConstraints = parse(studyRow.constraints_json) || {};
    const { next, changed, summary } = mergeStudyConstraints(currentConstraints, body, parsed);
    if (changed) {
      // Keep study.metric coherent with an explicit primary_metric change (the launch
      // path falls back to study.metric, and the report/grader read study.metric).
      const newMetric =
        next.primary_metric && next.primary_metric !== currentConstraints.primary_metric
          ? next.primary_metric
          : studyRow.metric;
      await env.DB.prepare("UPDATE study SET constraints_json = ?, metric = ? WHERE id = ?")
        .bind(JSON.stringify(next), newMetric, body.study_id)
        .run();
      constraintsChanged = true;
      changeSummary = summary;
    }
  }

  // Stamp the change marker INSIDE parsed_constraints_json (the feedback table has no
  // dedicated column). This is what resolveAppliedFeedbackId + grade.js read to find the
  // feedback that GENUINELY changed the contract — not merely any parsed feedback.
  const storedParsed =
    parsed || constraintsChanged
      ? { ...(parsed || {}), ...(constraintsChanged ? { constraints_changed: true, changed: changeSummary } : {}) }
      : null;

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
      storedParsed ? JSON.stringify(storedParsed) : null,
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
      constraints_changed: constraintsChanged,
      constraints_change_summary: constraintsChanged ? changeSummary : undefined,
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

  // C2 — study.status lifecycle {open,running,done,stopped}. A promote closes an OPEN
  // study (done); a stop marks it stopped. Guarded by the current status so a later
  // decision can't resurrect or clobber a terminal state.
  if (body.action === "promote") {
    await env.DB.prepare("UPDATE study SET status = 'done' WHERE id = ? AND status = 'open'")
      .bind(body.study_id)
      .run();
  } else if (body.action === "stop") {
    await env.DB.prepare("UPDATE study SET status = 'stopped' WHERE id = ? AND status IN ('open','running')")
      .bind(body.study_id)
      .run();
  }

  // C3 — a reject decision targeting a run marks that run's hypothesis 'rejected'
  // (only when it was still proposed/approved/tested, never overriding another reject).
  if (body.action === "reject" && body.rejected_run_id) {
    await env.DB.prepare(
      `UPDATE hypothesis SET status = 'rejected'
         WHERE id = (SELECT hypothesis_id FROM run WHERE id = ? AND study_id = ?)
           AND status IN ('proposed','approved','tested')`,
    )
      .bind(body.rejected_run_id, body.study_id)
      .run();
  }

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

/**
 * Extract the study's false-positive-rate upper bound from its constraints, if any.
 * Reads constraints.guardrails which may be an array of strings ("false_positive_rate
 * <= 0.20") and/or a guardrail string, plus a structured constraints.guardrail.
 * Returns a number in [0,1] or null when no FPR bound is declared.
 */
function studyFprBound(constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  const candidates = [];
  const push = (item) => {
    // Accept plain strings AND { expr: "..." } guardrail objects (the shape the cockpit
    // and createStudy persist, and the shape a merged FPR feedback now writes).
    if (typeof item === "string") candidates.push(item);
    else if (item && typeof item === "object" && typeof item.expr === "string") candidates.push(item.expr);
  };
  const g = constraints.guardrails;
  if (Array.isArray(g)) g.forEach(push);
  else push(g);
  push(constraints.guardrail);
  let bound = null;
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const m = c.match(/false[_\s]?positive[_\s]?rate\s*<=?\s*([0-9]*\.?[0-9]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && (bound === null || v < bound)) bound = v;
    }
  }
  return bound;
}

/** Read a manifest's declared max_fpr (manifest.metric.max_fpr, with a top-level
 *  manifest.max_fpr fallback). Returns a finite number or null. */
function manifestMaxFpr(manifest) {
  const v = manifest && ((manifest.metric && manifest.metric.max_fpr) ?? manifest.max_fpr);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * C11 — resolve the feedback id this run applied. Prefer an explicit value on the
 * payload; else auto-attach the most-recent feedback that ACTUALLY changed the study's
 * enforced contract (constraints_changed marker in parsed_constraints_json). This is a
 * real causal link: the run is launched against the mutated `study.constraints`, so it
 * points at the feedback that produced them — not merely any feedback that parsed.
 * Returns a feedback id string or null.
 */
async function resolveAppliedFeedbackId(env, studyId, explicit) {
  if (explicit) return explicit;
  // Prefer feedback that mutated the contract (the genuine cause of this run's bounds).
  const changed = await env.DB.prepare(
    `SELECT id FROM feedback
       WHERE study_id = ? AND parsed_constraints_json LIKE '%"constraints_changed":true%'
       ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(studyId)
    .first();
  if (changed) return changed.id;
  // Fallback: most-recent parsed-constraint feedback (back-compat; not a contract change).
  const row = await env.DB.prepare(
    `SELECT id FROM feedback
       WHERE study_id = ? AND parsed_constraints_json IS NOT NULL AND parsed_constraints_json <> ''
       ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(studyId)
    .first();
  return row ? row.id : null;
}

/** C3 — once a run is recorded for a hypothesis, advance the hypothesis to 'tested'
 *  (only from proposed/approved; never overriding a terminal 'rejected'). */
async function markHypothesisTested(env, hypothesisId) {
  if (!hypothesisId) return;
  await env.DB.prepare(
    "UPDATE hypothesis SET status = 'tested' WHERE id = ? AND status IN ('proposed','approved')",
  )
    .bind(hypothesisId)
    .run();
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
  // Default-fill dataset_uri from the study so the agent need not invent it (no tool
  // exposes the storage location). The agent normally copies it from profile_dataset;
  // this is the safety net so a manifest can omit it without a spurious 422.
  if (manifest && manifest.study_id && !manifest.dataset_uri) {
    const sr0 = await getStudyRow(env, manifest.study_id);
    if (sr0) manifest.dataset_uri = datasetUriFor(env, mapStudy(sr0));
  }

  // SCRIPT path: the agent authored a self-contained Python training script. We run it
  // in a network-isolated Modal Sandbox (the runner's dual-mode endpoint), NOT the
  // legacy manifest->sklearn path. Same gates and recording; no model.family/metric.
  if (manifest && typeof manifest.script === "string" && manifest.script.trim().length) {
    return launchScriptExperiment(env, manifest);
  }

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

  // Enforce the study's CURRENT banned_columns — including any a human banned via
  // feedback ("stop using region"). validateManifest() only sees dataset-version bans;
  // this catches bans that live on study.constraints (the causally-mutated contract).
  const studyBanned = (study.constraints && study.constraints.banned_columns) || [];
  const bannedInFeatures = (manifest.features || []).filter((c) => studyBanned.includes(c));
  if (bannedInFeatures.length) {
    return fail(422, "invalid_manifest", `banned columns present in features: ${[...new Set(bannedInFeatures)].sort().join(", ")}`);
  }

  // C5 — FPR guardrail. If the manifest declares metric.max_fpr that EXCEEDS the
  // study's false_positive_rate guardrail bound, reject (422): a tuning target looser
  // than the agreed guardrail would silently violate the metric contract.
  const fprBound = studyFprBound(study.constraints);
  const declaredMaxFpr = manifestMaxFpr(manifest);
  if (fprBound !== null && declaredMaxFpr !== null && declaredMaxFpr > fprBound) {
    return fail(
      422,
      "invalid_manifest",
      `manifest.metric.max_fpr (${declaredMaxFpr}) exceeds the study guardrail false_positive_rate <= ${fprBound}`,
    );
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

  // 3. Submit the manifest to the fixed Modal runner (no arbitrary code). Pass the
  // guardrail context through in `declared` so the runner can enforce/threshold on it.
  const primaryMetric = (study.constraints && study.constraints.primary_metric) || study.metric || null;
  const runnerPayload = {
    ...manifest,
    declared: {
      ...(manifest.declared || {}),
      ...(declaredMaxFpr !== null ? { max_fpr: declaredMaxFpr } : fprBound !== null ? { max_fpr: fprBound } : {}),
      ...(primaryMetric ? { primary_metric: primaryMetric } : {}),
    },
  };
  const result = await runOnModal(env, runnerPayload);
  if (result.error === "runner_unavailable") {
    return fail(502, "runner_unavailable", result.detail || "MODAL_RUNNER_URL is not configured.");
  }
  if (result.status === "rejected") {
    return fail(422, "invalid_manifest", result.reason || "runner rejected the manifest");
  }

  // 4. Record the manifest + the run with metrics/params/artifacts and provenance.
  // C11 — resolve which human feedback shaped this run (explicit, else most-recent
  // feedback that produced parsed_constraints) and persist it on BOTH manifest + run.
  const appliedFeedbackId = await resolveAppliedFeedbackId(env, study.id, manifest.applied_feedback_id);
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
      appliedFeedbackId,
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
  // C6 — persist model_family. Manifest path already has model.family; keep a
  // params.model fallback for parity with the script path.
  const modelFamily = manifest.model?.family ?? params.model ?? null;
  const runId = newId("run");

  await env.DB.prepare(
    `INSERT INTO run (id, study_id, hypothesis_id, manifest_id, tracker_run_id, status, model_family,
       metrics_json, params_json, artifacts_json, rationale, tags_json, executor, dataset_hash, code_hash, seed, applied_feedback_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      runId,
      study.id,
      manifest.hypothesis_id,
      manifestId,
      result.tracker_run_id ?? null,
      status,
      modelFamily,
      JSON.stringify(metrics),
      JSON.stringify(params),
      JSON.stringify(artifacts),
      rationale,
      JSON.stringify(manifest.tags || []),
      "modal-runner",
      prov.dataset_hash ?? null,
      prov.code_hash ?? null,
      seed,
      appliedFeedbackId,
      created,
    )
    .run();

  // C3 — recording a run for a hypothesis advances it proposed/approved -> tested.
  await markHypothesisTested(env, manifest.hypothesis_id);

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
      applied_feedback_id: appliedFeedbackId ?? undefined,
      created_at: created,
    }),
    201,
  );
}

/**
 * SCRIPT path for launch_experiment — the agent submits a Python training script that
 * runs in a network-isolated Modal Sandbox. Reuses the manifest path's gates (approval,
 * budget) and the SAME leakage checks, then relays the runner's dual-mode { script,
 * dataset_uri, declared } response and records a run + the script as the manifest.
 */
async function launchScriptExperiment(env, manifest) {
  // study + data contract
  const studyRow = await getStudyRow(env, manifest.study_id);
  if (!studyRow) return fail(422, "invalid_manifest", `unknown study_id ${manifest.study_id}`);
  const study = mapStudy(studyRow);
  const dvRow = await latestDatasetVersionRow(env, manifest.study_id);
  const dv = mapDatasetVersion(dvRow);

  // 1. Methodology guardrails (422). The script path skips model.family/metric.
  if (!manifest.hypothesis_id) {
    return fail(422, "invalid_manifest", "manifest.hypothesis_id is required (every run links to a hypothesis)");
  }
  if (!manifest.split || manifest.split.seed === undefined || manifest.split.seed === null) {
    return fail(422, "invalid_manifest", "manifest.split.seed is required (reproducibility)");
  }
  // tune_on may live at the top level or under search; reject test on either.
  const resolvedTuneOn = manifest.tune_on ?? manifest.search?.tune_on;
  if (String(resolvedTuneOn ?? "").trim().toLowerCase() === "test") {
    return fail(422, "invalid_manifest", "tuning on the test split is forbidden; use tune_on=validation");
  }

  // The banned/leaky set: study constraints ∪ profile leakage ∪ dataset_version
  // banned/leakage ∪ any manifest-declared banned columns. SAME leakage enforcement
  // as the manifest path; no banned/leaky column may appear in features.
  const constraints = parse(studyRow.constraints_json) || {};
  const profileLeak = profileFor(study.dataset_id, study.target).leakage_candidates || [];
  const bannedSet = new Set([
    ...(constraints.banned_columns || []),
    ...profileLeak,
    ...((dv && dv.banned_columns) || []),
    ...((dv && dv.leakage_candidates) || []),
    ...(manifest.banned_columns || []),
  ]);
  const features = manifest.features || [];
  const leaked = features.filter((c) => bannedSet.has(c));
  if (leaked.length) {
    return fail(422, "invalid_manifest", `banned/leaky columns present in features: ${[...new Set(leaked)].sort().join(", ")}`);
  }

  // C5 — FPR guardrail (same rule as the manifest path): a declared max_fpr looser
  // than the study's false_positive_rate guardrail bound is rejected (422).
  const fprBound = studyFprBound(study.constraints);
  const declaredMaxFpr = manifestMaxFpr(manifest);
  if (fprBound !== null && declaredMaxFpr !== null && declaredMaxFpr > fprBound) {
    return fail(
      422,
      "invalid_manifest",
      `manifest.metric.max_fpr (${declaredMaxFpr}) exceeds the study guardrail false_positive_rate <= ${fprBound}`,
    );
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

  // 3. Submit the script to the runner's Sandbox executor (dual-mode body w/ "script").
  // C5 — thread the FPR bound + primary metric through `declared` for runner enforcement.
  const effectiveMaxFpr = declaredMaxFpr ?? fprBound;
  const primaryMetric = (study.constraints && study.constraints.primary_metric) || study.metric || null;
  const payload = {
    script: manifest.script,
    dataset_uri: manifest.dataset_uri,
    declared: {
      features,
      banned_columns: [...bannedSet],
      seed: manifest.split.seed,
      tune_on: resolvedTuneOn || "validation",
      ...(effectiveMaxFpr !== null && effectiveMaxFpr !== undefined ? { max_fpr: effectiveMaxFpr } : {}),
      ...(primaryMetric ? { primary_metric: primaryMetric } : {}),
    },
  };
  const result = await runOnModal(env, payload);
  if (result.error === "runner_unavailable") {
    return fail(502, "runner_unavailable", result.detail || "MODAL_RUNNER_URL is not configured.");
  }
  if (result.status === "rejected") {
    return fail(422, "invalid_manifest", result.reason || "runner rejected the script");
  }

  // 4. Record the manifest (with the script in manifest_json) + the run.
  // C11 — resolve applied_feedback_id (explicit, else most-recent parsed-constraint
  // feedback). C6 — model_family comes from result.params.model on the script path.
  const appliedFeedbackId = await resolveAppliedFeedbackId(env, study.id, manifest.applied_feedback_id);
  const prov = result.provenance || {};
  const status = ["completed", "running", "failed", "queued"].includes(result.status) ? result.status : "completed";
  const metrics = numbersOnly(result.metrics || {});
  const params = result.params || {};
  const artifacts = result.artifacts || {};
  const seed = prov.seed ?? manifest.split.seed ?? null;
  const modelFamily = params.model ?? null; // C6: persist from result.params.model
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
      modelFamily,
      JSON.stringify(features),
      JSON.stringify(manifest.search || {}),
      JSON.stringify(manifest),
      manifest.split.seed ?? null,
      appliedFeedbackId,
      created,
    )
    .run();

  const hypRow = await env.DB.prepare("SELECT * FROM hypothesis WHERE id = ?").bind(manifest.hypothesis_id).first();
  const rationale = hypRow
    ? `Tests: ${hypRow.statement}`
    : `Run for hypothesis ${manifest.hypothesis_id} on study ${study.id}.`;

  const runId = newId("run");

  await env.DB.prepare(
    `INSERT INTO run (id, study_id, hypothesis_id, manifest_id, tracker_run_id, status, model_family,
       metrics_json, params_json, artifacts_json, rationale, tags_json, executor, dataset_hash, code_hash, seed, applied_feedback_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      runId,
      study.id,
      manifest.hypothesis_id,
      manifestId,
      result.tracker_run_id ?? null,
      status,
      modelFamily,
      JSON.stringify(metrics),
      JSON.stringify(params),
      JSON.stringify(artifacts),
      rationale,
      JSON.stringify(manifest.tags || []),
      "modal-runner",
      prov.dataset_hash ?? null,
      prov.code_hash ?? null,
      seed,
      appliedFeedbackId,
      created,
    )
    .run();

  // C3 — advance the hypothesis proposed/approved -> tested now that a run exists.
  await markHypothesisTested(env, manifest.hypothesis_id);

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
      applied_feedback_id: appliedFeedbackId ?? undefined,
      created_at: created,
    }),
    201,
  );
}

async function runOnModal(env, payload) {
  const url = env.MODAL_RUNNER_URL;
  if (!url) return { error: "runner_unavailable", detail: "MODAL_RUNNER_URL is not configured." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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

function buildModelCard(study, dv, L, best, baseline, opts = {}) {
  const promoted = opts.promoted || null;
  const provRun = opts.provRun || best || null;
  const extraNote = opts.extraNote || null;
  const metricLine = (r) => {
    if (!r || !r.metrics) return "n/a";
    return Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(4) : v}`)
      .join(", ");
  };
  const expRows = L.runs
    .map(
      (r) =>
        `| ${r.id} | ${r.model_family || (r.params && (r.params.model || r.params.family)) || "?"} | ${(r.tags || []).join(",") || "-"} | ${metricLine(r)} | ${r.status} |`,
    )
    .join("\n");
  const split = (dv && dv.split_strategy) || {};
  const reproCmd = "node .claude/workflows/run-study.js examples/" + study.dataset_id;

  // Generated per-study contracts (slice 2). Surface their key facts in the card so the
  // report's provenance reflects the actual contract, for any dataset.
  const dataContract = (dv && dv.contracts && dv.contracts.data) || null;
  const metricContract = (dv && dv.contracts && dv.contracts.metric) || null;
  const leakageLines = dataContract && dataContract.leakage_candidates && dataContract.leakage_candidates.length
    ? dataContract.leakage_candidates
        .map((l) => `  - \`${l.column}\`${l.reason ? ` — ${l.reason}` : ""}`)
        .join("\n")
    : null;
  const predictionTime = dataContract ? dataContract.prediction_time_assumption : null;
  const guardrailLine = metricContract && metricContract.guardrails && metricContract.guardrails.length
    ? metricContract.guardrails.join("; ")
    : "none";

  return `# Model card — ${study.id}

## Objective
${study.brief}

- **Target:** \`${study.target}\`
- **Primary metric:** ${(metricContract && metricContract.primary_metric) || study.metric}${study.metric_rationale ? ` — ${study.metric_rationale}` : ""}

## Data
- **Dataset:** ${study.dataset_id} (${dv ? dv.row_count : "?"} rows)
- **Split:** ${split.strategy || "?"}${split.time_col ? ` on \`${split.time_col}\`` : ""}, ratios ${JSON.stringify(split.ratios || [])}, seed ${split.seed}
- **Banned / leakage columns:** ${(dv && dv.banned_columns || []).join(", ") || "none"}
- **Target definition:** ${(dv && dv.target_definition) || "n/a"}${predictionTime ? `\n- **Prediction time:** ${predictionTime}` : ""}${leakageLines ? `\n- **Leakage candidates (banned):**\n${leakageLines}` : ""}${metricContract ? `\n- **Metric guardrails:** ${guardrailLine}` : ""}

## Experiments
| run | model | tags | metrics | status |
|---|---|---|---|---|
${expRows || "| (none) |  |  |  |  |"}

## Best vs baseline
- **Baseline:** ${baseline ? `${baseline.id} (${metricLine(baseline)})` : "not found"}
- **Best:** ${best ? `${best.id} (${metricLine(best)})` : "not found"}${best && promoted && best.id === promoted.id ? " — promoted" : ""}
- **Promoted:** ${promoted ? `${promoted.id} (${metricLine(promoted)})` : "none (no promote decision)"}
- **Compared:** ${best && baseline && !(best && baseline && best.id === baseline.id) ? "yes" : "no"}${extraNote ? `\n- **Note:** ${extraNote}` : ""}

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
_Provenance: dataset_hash=${(provRun && provRun.dataset_hash) || (dv && dv.file_hash) || "n/a"}, code_hash=${(provRun && provRun.code_hash) || "n/a"}, seed ${(provRun && provRun.seed) ?? split.seed ?? 42}._
`;
}

async function writeReport(env, body) {
  const studyRow = await getStudyRow(env, body.study_id);
  if (!studyRow) return notFound(`No study ${body.study_id}`);
  const study = mapStudy(studyRow);
  const L = await loadLedger(env, studyRow);
  const dv = L.dataset_version;
  const baseline = L.runs.find((r) => (r.tags || []).includes("baseline")) || null;

  // C4 — "best" reflects a TRUSTED outcome, not raw metric-max:
  //  - promoted = the run id of the MOST RECENT promote decision (the human/agent's pick)
  //  - best     = that promoted run if present, else the metric-max over NON-baseline runs
  // The provenance footer + artifact provenance bind to the SAME chosen run (real
  // code_hash + matching dataset_hash, never the literal 'pinned').
  const promoteDecisions = L.decisions.filter((d) => d.action === "promote" && d.promoted_run_id);
  const latestPromote = promoteDecisions.length ? promoteDecisions[promoteDecisions.length - 1] : null;
  const promoted = latestPromote
    ? L.runs.find((r) => r.id === latestPromote.promoted_run_id) || null
    : null;
  const metricMaxNonBaseline = bestRun(L.runs, { excludeBaseline: true });
  const best = promoted || metricMaxNonBaseline || null;

  // If the only candidate is the baseline (no tuned model beat it / none exist), say so.
  const bestIsBaseline = !!(best && baseline && best.id === baseline.id);
  const noTunedBeatBaseline = !promoted && !metricMaxNonBaseline; // nothing non-baseline to compare
  const comparesBestToBaseline = !!(best && baseline) && !bestIsBaseline && !noTunedBeatBaseline;
  const extraNote = !comparesBestToBaseline && baseline ? "no tuned model beat baseline" : null;

  // The run whose provenance the report inherits (promoted first, else best).
  const provRun = promoted || best || null;

  const card = buildModelCard(study, dv, L, best, baseline, { promoted, provRun, extraNote });
  const reportType = body.report_type || "model_card";
  const key = `studies/${study.id}/report/${reportType}_${Date.now()}.md`;
  await env.ARTIFACTS.put(key, card, { httpMetadata: { contentType: "text/markdown" } });

  const datasetHash = (provRun && provRun.dataset_hash) || (dv && dv.file_hash) || (await sha256hex(study.dataset_id));
  // C4 — real code_hash from the chosen run; only synthesize a card-content hash if the
  // run genuinely has none (never the literal string 'pinned').
  const codeHash = (provRun && provRun.code_hash) || (await sha256hex(card)).slice(0, 12);
  const seed = (provRun && provRun.seed) ?? (dv && dv.split_strategy && dv.split_strategy.seed) ?? 42;
  const reproCmd = `node .claude/workflows/run-study.js examples/${study.dataset_id}`;

  const artifactId = newId("art");
  const meta = compact({
    best_run_id: best ? best.id : null,
    promoted_run_id: promoted ? promoted.id : null, // C4: store BOTH
    baseline_run_id: baseline ? baseline.id : null,
    compares_best_to_baseline: comparesBestToBaseline,
    reproducible_command: reproCmd,
    report_type: reportType,
    note: extraNote || undefined,
  });
  await env.DB.prepare(
    `INSERT INTO artifact (id, study_id, run_id, kind, uri, dataset_hash, code_hash, seed, meta_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      artifactId,
      study.id,
      // C4 — artifact.run_id binds to the PROMOTED run (else best).
      (promoted && promoted.id) || (best && best.id) || null,
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
      markdown: card,
      generated_at: nowIso(),
      best_run_id: best ? best.id : undefined,
      promoted_run_id: promoted ? promoted.id : undefined,
      baseline_run_id: baseline ? baseline.id : undefined,
      compares_best_to_baseline: comparesBestToBaseline,
      note: extraNote || undefined,
      reproducible_command: reproCmd,
      provenance: { dataset_hash: datasetHash, code_hash: codeHash, seed },
    }),
    201,
  );
}

/**
 * Serve the latest rendered model card for a study (public read). Returns the
 * stored markdown plus its provenance/links from the artifact row. With
 * ?format=md, returns the raw markdown as text/markdown (linkable/downloadable);
 * otherwise JSON the cockpit renders inline. 404 when no report exists yet.
 */
async function getReport(env, id, url) {
  const studyRow = await getStudyRow(env, id);
  if (!studyRow) return notFound(`No study ${id}`);
  const row = await env.DB.prepare(
    `SELECT * FROM artifact WHERE study_id = ? AND kind = 'report' ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(id)
    .first();
  if (!row) return notFound(`No report for ${id}`);

  // C8 — the artifact row exists but its R2 object is gone (or R2 is unbound): that is
  // a 404, not an empty 200. Apply to BOTH the markdown (?format=md) and JSON branches
  // so a missing object never renders as a blank-but-successful report.
  const obj = env.ARTIFACTS ? await env.ARTIFACTS.get(row.uri) : null;
  if (!obj) return notFound(`Report object missing for ${id} (${row.uri})`);
  const markdown = await obj.text();

  if (url && url.searchParams.get("format") === "md") {
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-cache",
        ...CORS,
      },
    });
  }

  const meta = parse(row.meta_json) || {};
  return json(
    compact({
      study_id: id,
      uri: row.uri,
      markdown,
      generated_at: row.created_at,
      best_run_id: meta.best_run_id || undefined,
      promoted_run_id: meta.promoted_run_id || undefined,
      baseline_run_id: meta.baseline_run_id || undefined,
      compares_best_to_baseline: meta.compares_best_to_baseline || undefined,
      note: meta.note || undefined,
      reproducible_command: meta.reproducible_command || undefined,
      provenance: { dataset_hash: row.dataset_hash, code_hash: row.code_hash, seed: row.seed },
    }),
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

/**
 * Ask the agent runtime to start a session for this study — RELIABLY.
 *
 * Why this is not a bare `fetch(...).catch(() => {})`: in a Cloudflare Worker an
 * un-awaited fetch is cancelled the instant the request handler's Response resolves,
 * so a fire-and-forget kick frequently never reaches the runtime → the study never
 * starts (a race). To guarantee the kick runs without blocking the create response we
 * register the work with `ctx.waitUntil(...)`, which keeps it alive after we return.
 *
 * The kick itself is hardened with a short per-attempt timeout and a bounded retry so a
 * transient runtime hiccup (cold start, brief 5xx, dropped connection) doesn't
 * permanently drop the kick. The runtime's /agent/start is idempotent and re-kickable
 * for a dead session, so retries are safe.
 *
 * Returns the (resolved-on-completion) promise so callers/tests can await it. When no
 * runtime is wired (AGENT_RUNTIME_URL empty, e.g. the contract-test env) it skips
 * silently and resolves immediately.
 */
function triggerAgentStart(env, studyId, ctx) {
  const base = (env.AGENT_RUNTIME_URL || "").replace(/\/$/, "");
  if (!base) return Promise.resolve(); // no runtime wired — skip silently

  const ATTEMPTS = 2; // total attempts (1 initial + 1 retry)
  const TIMEOUT_MS = 5000; // per-attempt cap so a hung runtime can't pin the kick
  const BACKOFF_MS = 250; // short backoff between attempts

  const kick = (async () => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      // AbortController gives each attempt a bounded lifetime; a hung connection is
      // aborted and treated as a failed attempt (retried if any remain).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/agent/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ study_id: studyId }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        // 2xx (incl. the runtime's 202 "started") means the kick landed — done.
        if (res.ok) return;
        // A 5xx is transient (cold start, restart) — retry. A 4xx is a permanent
        // client error (bad request); retrying won't help, so stop.
        if (res.status < 500) return;
      } catch {
        clearTimeout(timer);
        // Network error / abort — fall through to retry if attempts remain.
      }
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
    // Exhausted attempts: the SSE stream route (GET /api/studies/{id}/stream)
    // historically self-healed by starting on subscribe; that is no longer the kick
    // path, but a human re-open / a re-kick still recovers. We swallow rather than
    // throw so waitUntil doesn't log an unhandled rejection.
  })();

  // Keep the kick alive past the response. ctx may be absent in some embeddings/tests;
  // fall back to returning the promise (caller can await) without crashing.
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(kick);
  return kick;
}

/**
 * Inject a human "suggest changes" message into the running Managed Agents session
 * by proxying {text} to the agent runtime. Returns the runtime's JSON response, or
 * a 503 { error: "runtime_unavailable" } when no runtime is wired.
 */
async function proxyAgentMessage(env, studyId, body) {
  const base = (env.AGENT_RUNTIME_URL || "").replace(/\/$/, "");
  if (!base) return fail(503, "runtime_unavailable", "AGENT_RUNTIME_URL is not configured.");
  const text = body && typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return fail(400, "bad_request", "text is required.");
  try {
    const res = await fetch(`${base}/agent/${encodeURIComponent(studyId)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => null);
    return json(data ?? { status: res.ok ? "queued" : "error" }, res.status);
  } catch (e) {
    return fail(503, "runtime_unavailable", String(e?.message ?? e));
  }
}

/**
 * Proxy the agent runtime's SSE event stream through to the cockpit (public).
 *
 * C9 robustness:
 *  - Hop-by-hop `connection: keep-alive` is dropped (it's invalid on a fetch Response
 *    and must not be forwarded by a proxy).
 *  - A FINITE response (single frame, no live body) is always 200 so EventSource
 *    LATCHES it and stops auto-reconnecting. We only stream the live upstream body when
 *    upstream is a genuine `text/event-stream`.
 *  - A non-OK upstream or a non-event-stream content-type yields a 200 `event: error`
 *    frame (finite) instead of piping junk that would make the client reconnect-loop.
 *  - When the study has reached a terminal state, emit an `event: done` frame.
 */
async function proxyAgentStream(env, studyId, request) {
  // SSE response headers — note: NO `connection` header (hop-by-hop; dropped per C9).
  const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    ...CORS,
  };
  // A finite SSE response: one or more frames, then EOF. 200 so the cockpit latches it.
  const finite = (frames) => new Response(frames, { status: 200, headers: sseHeaders });
  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  // Is the study already in a terminal state? If so we can short-circuit with `done`.
  let studyStatus = null;
  try {
    const row = await env.DB.prepare("SELECT status FROM study WHERE id = ?").bind(studyId).first();
    studyStatus = row ? row.status : null;
  } catch {
    // Best-effort: a read failure here must not break the public stream.
  }
  const isFinished = studyStatus === "done" || studyStatus === "stopped";

  const base = (env.AGENT_RUNTIME_URL || "").replace(/\/$/, "");
  if (!base) {
    // No runtime configured — emit one informational (or done) frame and close so the
    // cockpit renders a clean state instead of reconnecting forever.
    if (isFinished) return finite(frame("done", { study_id: studyId, status: studyStatus }));
    return finite(frame("info", { kind: "runtime_unavailable", study_id: studyId }));
  }

  // A finished study needs no live upstream — emit a terminal `done` frame.
  if (isFinished) return finite(frame("done", { study_id: studyId, status: studyStatus }));

  try {
    // Forward the client's Last-Event-ID upstream so the runtime replays only the
    // frames AFTER it on reconnect (the runtime stamps a monotonic `id:` per frame and
    // honors this header). Harmless when absent.
    const lastEventId = request && request.headers ? request.headers.get("last-event-id") : null;
    const upstream = await fetch(`${base}/agent/${encodeURIComponent(studyId)}/stream`, {
      headers: {
        accept: "text/event-stream",
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
    });
    const ct = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !/text\/event-stream/i.test(ct)) {
      // Upstream is unhealthy or not an event stream — return a FINITE error frame so
      // EventSource stops reconnecting (a streamed non-200 would trigger a retry loop).
      return finite(
        frame("error", {
          kind: "runtime_bad_stream",
          status: upstream.status,
          content_type: ct || null,
        }),
      );
    }
    // Healthy event stream — pipe the live body through (drop the upstream status/headers,
    // use our sanitized SSE headers; 200 keeps the connection semantics clean).
    return new Response(upstream.body, { status: 200, headers: sseHeaders });
  } catch (e) {
    return finite(frame("error", { kind: "runtime_unreachable", detail: String(e?.message ?? e) }));
  }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Preflight: reflect the requested headers (CORS fix) so a custom client header
    // never fails the preflight. Origin stays `*` (bearer-only API, no cookies).
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

    // Best-effort schema bootstrap. A transient DDL failure must NOT take down public
    // reads — ensureSchema now resolves to false instead of throwing, and write paths
    // separately call requireSchema() to hard-require the schema before mutating.
    await ensureSchema(env);

    // Public landing page (the real cockpit is the front-end track's apps/cockpit).
    if (method === "GET" && pathname === "/") {
      return new Response(LANDING_HTML, { headers: { "content-type": "text/html", ...CORS } });
    }

    // Public: serve a study's dataset CSV from R2 so the (cloud) Modal runner can
    // fetch it. dataset_uri resolves to {LABMATE_DATASET_BASE}/{dataset_id}.csv, and
    // LABMATE_DATASET_BASE points at "{this Worker}/data" in the deployed env.
    if (method === "GET" && pathname.startsWith("/data/")) {
      return serveDataset(env, pathname.slice("/data/".length));
    }

    // Public reads
    if (method === "GET" && pathname === "/api/studies") return listStudies(env, url);
    if (method === "GET" && pathname.startsWith("/api/studies/")) {
      const rest = decodeURIComponent(pathname.slice("/api/studies/".length));
      // Live agent activity (SSE) — the control plane proxies the agent runtime's
      // event stream through to the cockpit. Public, like the other reads.
      if (rest.endsWith("/stream")) {
        return proxyAgentStream(env, rest.slice(0, -"/stream".length), request);
      }
      // Latest rendered model card. JSON by default (cockpit reads .markdown), or
      // raw text/markdown with ?format=md (downloadable / linkable).
      if (rest.endsWith("/report")) {
        return getReport(env, rest.slice(0, -"/report".length), url);
      }
      // C7 — GET /api/studies/{id}/grade is a pure READ (no mutation), so it is public
      // and reuses the same gradeStudy logic as POST /api/grade.
      if (rest.endsWith("/grade")) {
        return gradeStudy(env, { study_id: rest.slice(0, -"/grade".length) });
      }
      return getStudyDetail(env, rest);
    }

    // Writes require the internal token.
    if (pathname.startsWith("/api/")) {
      // C10 — refuse writes when the SERVER token is missing or too short (<24 chars),
      // with a clear 503 (vs an opaque 401). Reads above already returned; only write
      // routes reach here. Never falls back to a hardcoded default token.
      if (!serverTokenUsable(env)) return writesDisabled();
      if (!checkAuth(request, env)) return unauthorized();
      // Writes mutate the ledger — hard-require the schema (best-effort bootstrap may
      // have failed above without taking down reads). A real failure surfaces as 500.
      try {
        await requireSchema(env);
      } catch (e) {
        return serverError(env, "schema_error", e);
      }
      // Dataset upload accepts a RAW text/csv body (not JSON), so it is dispatched
      // before the generic JSON parse below consumes the request stream. JSON
      // { csv, dataset_id? } is also accepted (uploadDataset re-reads the body).
      if (method === "POST" && pathname === "/api/datasets") {
        try {
          return await uploadDataset(env, null, request);
        } catch (e) {
          return serverError(env, "internal_error", e);
        }
      }

      let body = {};
      if (method === "POST") {
        body = await request.json().catch(() => null);
        if (body === null) return fail(400, "bad_request", "Body must be valid JSON.");
      }
      // Path-param write: POST /api/studies/{id}/message injects a human "suggest
      // changes" user.message into the running session (token-required, like the
      // other writes). Matched here because it carries a path param the switch can't.
      if (method === "POST" && /^\/api\/studies\/[^/]+\/message$/.test(pathname)) {
        const id = decodeURIComponent(pathname.slice("/api/studies/".length, -"/message".length));
        try {
          return await proxyAgentMessage(env, id, body);
        } catch (e) {
          return serverError(env, "internal_error", e);
        }
      }
      try {
        switch (`${method} ${pathname}`) {
          case "POST /api/studies":
            return await createStudy(env, body, ctx);
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
 * Durable Object: RESERVED, not yet wired. The binding (env.STUDY) and the v1 migration
 * are declared in wrangler.toml so the class deploys cleanly and a future live-update
 * channel can attach without a breaking migration — but NOTHING currently instantiates
 * this DO. Live cockpit updates today flow over the SSE proxy (GET .../stream), and the
 * ledger is read via GET /api/studies/{id}. Do not remove the binding/migration (that
 * would break the deploy); this stub is intentionally minimal until the channel lands.
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
