/**
 * Per-study contract generation — "the contract is the product".
 *
 * Given a study (its config + constraints) and a RESOLVED dataset profile (either the
 * bundled golden `sla_tickets` profile or a real `profileCsv` of an uploaded CSV), this
 * derives a structured PER-STUDY data contract + metric contract. Deterministic: the
 * same study + profile always produce the same contract (no clock, no randomness), so it
 * is part of the reproducible ledger.
 *
 * This is what makes "the contract is the product" work for ANY uploaded dataset, not
 * just the committed golden docs/data_contract.md / docs/metric_contract.md (which now
 * describe the demo's GENERATED contract, kept identical via the bundled profile).
 *
 *   buildDataContract(study, profile, constraints)   -> structured data contract
 *   buildMetricContract(study, profile, constraints) -> structured metric contract
 *   buildContracts(study, profile, constraints)      -> { data, metric }
 */

const DEFAULT_SEED = 42;

const uniq = (arr) => [...new Set(arr)];

/** Split out the profile's columns by inferred dtype. dtypes come from profileCsv
 *  (numeric/categorical/datetime/boolean/text) OR the bundled profile
 *  (int/category/datetime/text). We normalize both into the contract's buckets. */
function bucketColumns(columns, target) {
  const categoricals = [];
  const datetimeCols = [];
  const numeric = [];
  const missingness = {};
  for (const c of columns) {
    if (!c || !c.name) continue;
    const name = c.name;
    const dt = String(c.dtype || "").toLowerCase();
    // missingness map: only record columns that actually have missing values.
    const frac = typeof c.missing_fraction === "number" ? c.missing_fraction : 0;
    if (frac > 0) missingness[name] = round4(frac);
    if (name === target) continue; // the target is described separately
    if (dt === "datetime" || dt === "date") datetimeCols.push(name);
    else if (dt === "category" || dt === "categorical" || dt === "boolean" || dt === "bool")
      categoricals.push(name);
    else if (dt === "numeric" || dt === "int" || dt === "integer" || dt === "float" || dt === "number")
      numeric.push(name);
    // 'text' and unknown dtypes are intentionally not bucketed as a modeling dtype.
  }
  return { categoricals, datetimeCols, numeric, missingness };
}

/** Pull leakage-candidate column entries (with reasons) from the profile. Prefers the
 *  per-column `is_candidate_leakage` + `leakage_reason` (real profiling); falls back to
 *  the profile's flat `leakage_candidates` list for the bundled golden profile. */
function leakageEntries(profile) {
  const cols = profile.columns || [];
  const byName = new Map(cols.map((c) => [c.name, c]));
  const out = [];
  const seen = new Set();
  const add = (name, reason) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(reason ? { column: name, reason } : { column: name });
  };
  for (const c of cols) {
    if (c && c.is_candidate_leakage) add(c.name, c.leakage_reason);
  }
  // Bundled / flat profile: leakage_candidates without per-column flags.
  for (const name of profile.leakage_candidates || []) {
    const c = byName.get(name);
    add(name, c && c.leakage_reason);
  }
  return out;
}

/** Use a split the study explicitly declared (rare); else null. */
function studyDeclaredSplit(study) {
  const c = study && study.constraints;
  if (c && c.split && c.split.strategy) return c.split;
  return null;
}

/**
 * Build the structured PER-STUDY data contract.
 *
 * @param {object} study        mapped study row (target, dataset_id, constraints, ...)
 * @param {object} profile      resolved dataset profile (bundled or profileCsv output)
 * @param {object} [constraints] parsed study.constraints (banned_columns, ...)
 * @returns a deterministic data contract object.
 */
export function buildDataContract(study, profile, constraints = {}) {
  const target = study.target || profile.target || "target";
  const columns = profile.columns || [];
  const { categoricals, datetimeCols, numeric, missingness } = bucketColumns(columns, target);

  const leakage = leakageEntries(profile);
  const leakageNames = leakage.map((l) => l.column);

  // Safe features = profiled non-target, non-leakage columns. Prefer the profile's own
  // safe_features (already excludes target+leakage) and union with any other observed
  // non-target/non-leakage columns. Deterministic by column order.
  const observedFeatures = columns
    .map((c) => c.name)
    .filter((n) => n && n !== target && !leakageNames.includes(n));
  const safeFeatures = uniq([...(profile.safe_features || []), ...observedFeatures]).filter(
    (n) => n !== target && !leakageNames.includes(n),
  );

  // banned = study-declared banned columns ∪ all leakage candidates (default-ban policy).
  const banned = uniq([...(constraints.banned_columns || []), ...leakageNames]);

  const split =
    profile.split ||
    studyDeclaredSplit(study) || { strategy: "random", ratios: [0.7, 0.15, 0.15], seed: DEFAULT_SEED };
  const splitOut = {
    strategy: split.strategy || "random",
    ratios: split.ratios || [0.7, 0.15, 0.15],
    seed: split.seed ?? DEFAULT_SEED,
  };
  if (split.time_col) splitOut.time_col = split.time_col;

  // Prediction-time assumption: when we split on a creation timestamp, anything after it
  // is post-outcome. State it explicitly so the leakage policy is legible.
  const predictionTime = splitOut.time_col
    ? `Prediction is made at the time of \`${splitOut.time_col}\`. Any field populated after that moment is leakage.`
    : "Prediction is made at row-creation time. Any field populated after that moment is leakage.";

  return {
    target,
    target_definition: profile.target_definition || null,
    prediction_time_assumption: predictionTime,
    leakage_candidates: leakage,
    safe_features: safeFeatures,
    categoricals,
    datetime_columns: datetimeCols,
    numeric,
    row_count: profile.row_count ?? 0,
    missingness,
    split_strategy: splitOut,
    banned_columns: banned,
  };
}

// ---------------------------------------------------------------------------
// metric contract
// ---------------------------------------------------------------------------

/** Infer the task type for a study: explicit study.task_type wins; else infer from the
 *  target column's dtype/cardinality in the profile. Binary 0/1 ⇒ classification;
 *  a numeric target with many distinct values ⇒ regression. */
export function inferTaskType(study, profile) {
  if (study.task_type) return study.task_type;
  const col = (profile.columns || []).find((c) => c.name === study.target);
  if (col) {
    const dt = String(col.dtype || "").toLowerCase();
    const card = col.n_unique ?? col.cardinality;
    if (dt === "boolean" || dt === "bool") return "binary_classification";
    if (card === 2) return "binary_classification";
    if (dt === "numeric" || dt === "int" || dt === "integer" || dt === "float" || dt === "number") {
      if (typeof card === "number" && card > 10) return "regression";
      // small-cardinality numeric labels (0/1/2, …): treat as classification.
      return "binary_classification";
    }
    if (dt === "category" || dt === "categorical") return "binary_classification";
  }
  return "binary_classification";
}

/** Read the FPR upper bound declared anywhere in the study's constraints. Mirrors
 *  studyFprBound() in worker.js so the contract and the launch-time guardrail agree. */
function fprBoundFrom(constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  const candidates = [];
  const g = constraints.guardrails;
  if (Array.isArray(g)) candidates.push(...g);
  else if (typeof g === "string") candidates.push(g);
  if (typeof constraints.guardrail === "string") candidates.push(constraints.guardrail);
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

/**
 * Build the structured PER-STUDY metric contract from the study's metric/constraints +
 * the inferred task type. Deterministic.
 *
 * @param {object} study        mapped study row
 * @param {object} profile      resolved dataset profile
 * @param {object} [constraints] parsed study.constraints
 */
export function buildMetricContract(study, profile, constraints = {}) {
  const taskType = inferTaskType(study, profile);
  const isClassification = taskType !== "regression";
  const primary =
    (constraints && constraints.primary_metric) ||
    study.metric ||
    (isClassification ? "recall" : "rmse");
  const rationale =
    study.metric_rationale ||
    (constraints && constraints.metric_rationale) ||
    (isClassification
      ? `Optimizing ${primary} on the positive class; chosen at the human checkpoint.`
      : `Optimizing ${primary} for this regression target; chosen at the human checkpoint.`);

  // Guardrails: surface every declared guardrail string + the parsed FPR bound.
  const guardrails = [];
  const seenG = new Set();
  const addG = (s) => {
    if (typeof s === "string" && s.trim() && !seenG.has(s)) {
      seenG.add(s);
      guardrails.push(s);
    }
  };
  const g = constraints && constraints.guardrails;
  if (Array.isArray(g)) g.forEach(addG);
  else if (typeof g === "string") addG(g);
  if (typeof (constraints && constraints.guardrail) === "string") addG(constraints.guardrail);
  // Ensure the FPR bound (if any) is represented as a normalized guardrail too.
  const fpr = fprBoundFrom(constraints);
  if (fpr !== null) addG(`false_positive_rate <= ${fpr.toFixed(2)}`);

  // Sensible secondary/reporting metrics by task type.
  const secondary = isClassification
    ? ["precision", "pr_auc", "roc_auc", "confusion_matrix"]
    : ["mae", "r2"];

  // Segments: from constraints (focus_segment / segments) — empty when none, the
  // cockpit can still set them at the human checkpoint.
  const segments = uniq([
    ...(Array.isArray(constraints && constraints.segments) ? constraints.segments : []),
    ...(constraints && constraints.focus_segment ? [constraints.focus_segment] : []),
  ]);

  return {
    task_type: taskType,
    primary_metric: primary,
    rationale,
    guardrails,
    secondary_metrics: secondary,
    segments,
    threshold_tuned_on: isClassification ? "validation" : null,
  };
}

/** Build both contracts for a study. */
export function buildContracts(study, profile, constraints = {}) {
  return {
    data: buildDataContract(study, profile, constraints),
    metric: buildMetricContract(study, profile, constraints),
  };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}
