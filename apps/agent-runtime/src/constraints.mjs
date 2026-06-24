/**
 * LLM-awareness of the study's CURRENT enforced contract.
 *
 * Enforcement is already causal: every launch re-reads `study.constraints` and the
 * runner enforces `max_fpr` / banned columns server-side (dispatch.mjs + the Worker).
 * But the LLM's *in-context* view of the contract goes stale: a human can record
 * constraint-bearing feedback (tightening the FPR bound, banning a column) via
 * `/agent/:id/message` OR out-of-band via `/api/feedback`, mutating
 * `study.constraints` — yet the model is never explicitly re-told the new contract.
 * It only discovers the change by hitting a rejection.
 *
 * This module turns the structured constraints into a concise natural-language
 * reminder we can inject so the LLM RE-PLANS toward the new bound rather than
 * rediscovering it via a 422. It is pure (no I/O) and tolerant of the several
 * constraint shapes the Worker emits.
 */

/**
 * Extract a human-readable FPR bound from a guardrail entry (string or `{expr}`
 * object). Returns the bound as a number, or null.
 */
function fprBoundFromGuardrail(g) {
  const expr = typeof g === "string" ? g : g && typeof g === "object" ? g.expr : null;
  if (typeof expr !== "string") return null;
  const m = expr.match(/false[_\s]?positive[_\s]?rate\s*<=?\s*([0-9]*\.?[0-9]+)\s*(%?)/i);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  if (m[2] === "%") v /= 100;
  if (v > 1) v /= 100;
  return v >= 0 && v <= 1 ? v : null;
}

/**
 * Normalize a study's `constraints` object into a stable summary:
 *   { primaryMetric, maxFpr, guardrails:[string], bannedColumns:[string] }
 * Tolerates `guardrails` as a list of strings or {expr} objects, a bare `guardrail`
 * string, and `banned_columns`. Returns null if there is nothing worth surfacing.
 */
export function summarizeConstraints(constraints) {
  if (!constraints || typeof constraints !== "object") return null;

  const primaryMetric = typeof constraints.primary_metric === "string" ? constraints.primary_metric : null;

  const guardrailExprs = [];
  let maxFpr = null;
  const raw = [];
  if (Array.isArray(constraints.guardrails)) raw.push(...constraints.guardrails);
  if (constraints.guardrail) raw.push(constraints.guardrail);
  for (const g of raw) {
    const expr = typeof g === "string" ? g : g && typeof g === "object" && typeof g.expr === "string" ? g.expr : null;
    if (expr) guardrailExprs.push(expr);
    const v = fprBoundFromGuardrail(g);
    if (v !== null) maxFpr = v;
  }
  if (maxFpr === null && constraints.max_fpr !== null && constraints.max_fpr !== undefined) {
    const v = Number(constraints.max_fpr);
    if (Number.isFinite(v)) {
      maxFpr = v > 1 ? v / 100 : v;
      guardrailExprs.push(`false_positive_rate <= ${maxFpr}`);
    }
  }

  const bannedColumns = Array.isArray(constraints.banned_columns)
    ? constraints.banned_columns.filter((c) => typeof c === "string" && c.length)
    : [];

  if (!primaryMetric && !guardrailExprs.length && !bannedColumns.length) return null;
  return { primaryMetric, maxFpr, guardrails: guardrailExprs, bannedColumns };
}

/**
 * Render the structured contract as one compact line the LLM can act on, e.g.
 *   `[current enforced contract] primary_metric=recall; guardrails: false_positive_rate <= 0.1; banned_columns: [region]. Plan all further experiments to satisfy this; the runner enforces it server-side.`
 * Returns null (no line) when there are no constraints to surface — so callers never
 * spam the model with an empty reminder.
 */
export function formatContractReminder(constraints) {
  const s = summarizeConstraints(constraints);
  if (!s) return null;
  const parts = [];
  if (s.primaryMetric) parts.push(`primary_metric=${s.primaryMetric}`);
  if (s.guardrails.length) parts.push(`guardrails: ${s.guardrails.join("; ")}`);
  if (s.bannedColumns.length) parts.push(`banned_columns: [${s.bannedColumns.join(", ")}]`);
  if (!parts.length) return null;
  return (
    `[current enforced contract] ${parts.join("; ")}. ` +
    `Plan all further experiments to satisfy this; the runner enforces it server-side.`
  );
}

/**
 * Best-effort: fetch a study's CURRENT constraints from the control plane. Never
 * throws — returns null on any error so callers can guard cheaply and never crash
 * the loop / inject path. `GET /api/studies/:id` returns either `{ study: {...} }`
 * (StudyDetail) or a bare Study; constraints live on `study.constraints`.
 *
 * @param {object} controlPlane client with `.get(path)`
 * @param {string} studyId
 * @returns {Promise<object|null>} the constraints object, or null
 */
export async function fetchStudyConstraints(controlPlane, studyId) {
  if (!controlPlane || typeof controlPlane.get !== "function" || !studyId) return null;
  try {
    const detail = await controlPlane.get(`/api/studies/${encodeURIComponent(studyId)}`);
    if (!detail || detail.error) return null;
    const study = detail.study ?? detail;
    return study?.constraints ?? null;
  } catch {
    return null;
  }
}

/**
 * Stable signature for a constraints summary so the loop can detect a CHANGE since the
 * last time it surfaced the contract (and only re-inject when it actually moved).
 */
export function constraintsSignature(constraints) {
  const s = summarizeConstraints(constraints);
  if (!s) return "";
  return JSON.stringify({
    m: s.primaryMetric ?? null,
    f: s.maxFpr ?? null,
    g: [...s.guardrails].sort(),
    b: [...s.bannedColumns].map((c) => c.toLowerCase()).sort(),
  });
}
