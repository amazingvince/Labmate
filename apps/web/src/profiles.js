/**
 * Dataset profiling + a deterministic hypothesis library.
 *
 * Two profiling paths share one output shape (the DatasetVersion the cockpit and the
 * grader consume):
 *
 *   - profileCsv(text, {target, datasetId}) — REAL profiling: parse an actual CSV and
 *     infer, per column, dtype / missingness / cardinality / example values / leakage,
 *     plus the row count, datetime columns, a suggested split, and suggested
 *     categoricals. This is what runs for any uploaded dataset.
 *
 *   - SLA_TICKETS_PROFILE — the bundled `sla_tickets` golden path. We ship a known-good
 *     profile so the demo is deterministic and offline (the bundled CSV is not in R2
 *     during `wrangler dev`). It mirrors docs/data_contract.md exactly (target, leakage
 *     candidates, split, seed). `profileFor` returns it when no uploaded CSV exists.
 */

export const SLA_TICKETS_PROFILE = {
  dataset_id: "sla_tickets",
  row_count: 12000,
  target: "breached_sla",
  target_definition:
    "A ticket breached if it was resolved after its SLA deadline, OR is still open " +
    "past the deadline. Defined at the moment of prediction = ticket creation.",
  // Post-outcome columns: known only after the ticket is resolved/closed.
  leakage_candidates: [
    "resolved_at",
    "time_to_resolution",
    "closed_status",
    "agent_notes_final",
  ],
  safe_features: [
    "priority",
    "customer_tier",
    "channel",
    "product_area",
    "region",
    "reporter_history_count",
    "queue_depth_at_creation",
    "is_reopen",
    "description_length",
    "business_hours_flag",
  ],
  split: {
    strategy: "time_based",
    time_col: "created_at",
    ratios: [0.7, 0.15, 0.15],
    seed: 42,
  },
  columns: [
    { name: "created_at", dtype: "datetime", missing_fraction: 0, is_candidate_leakage: false },
    { name: "priority", dtype: "category", missing_fraction: 0, n_unique: 4, is_candidate_leakage: false },
    { name: "customer_tier", dtype: "category", missing_fraction: 0.06, n_unique: 3, is_candidate_leakage: false },
    { name: "channel", dtype: "category", missing_fraction: 0, n_unique: 4, is_candidate_leakage: false },
    { name: "product_area", dtype: "category", missing_fraction: 0, n_unique: 5, is_candidate_leakage: false },
    { name: "region", dtype: "category", missing_fraction: 0.03, n_unique: 4, is_candidate_leakage: false },
    { name: "reporter_history_count", dtype: "int", missing_fraction: 0, is_candidate_leakage: false },
    { name: "queue_depth_at_creation", dtype: "int", missing_fraction: 0, is_candidate_leakage: false },
    { name: "is_reopen", dtype: "int", missing_fraction: 0, n_unique: 2, is_candidate_leakage: false },
    { name: "description_length", dtype: "int", missing_fraction: 0, is_candidate_leakage: false },
    { name: "business_hours_flag", dtype: "int", missing_fraction: 0, n_unique: 2, is_candidate_leakage: false },
    {
      name: "resolved_at",
      dtype: "datetime",
      missing_fraction: 0.18,
      is_candidate_leakage: true,
      leakage_reason: "Populated only after resolution; unknown at ticket creation.",
    },
    {
      name: "time_to_resolution",
      dtype: "int",
      missing_fraction: 0.18,
      is_candidate_leakage: true,
      leakage_reason: "Derived from resolution time; post-outcome.",
    },
    {
      name: "closed_status",
      dtype: "category",
      missing_fraction: 0.18,
      is_candidate_leakage: true,
      leakage_reason: "Set at close; encodes the outcome directly.",
    },
    {
      name: "agent_notes_final",
      dtype: "text",
      missing_fraction: 0.18,
      is_candidate_leakage: true,
      leakage_reason: "Written at close; frequently states the SLA outcome.",
    },
    { name: "breached_sla", dtype: "int", missing_fraction: 0, n_unique: 2, is_candidate_leakage: false },
  ],
};

const PROFILES = { sla_tickets: SLA_TICKETS_PROFILE };

/** Return the bundled profile for a dataset_id, or a minimal generic profile. */
export function profileFor(datasetId, target) {
  if (PROFILES[datasetId]) return PROFILES[datasetId];
  return {
    dataset_id: datasetId,
    row_count: 0,
    target: target || "target",
    target_definition: null,
    leakage_candidates: [],
    safe_features: [],
    split: { strategy: "time_based", ratios: [0.7, 0.15, 0.15], seed: 42 },
    columns: [],
  };
}

// ---------------------------------------------------------------------------
// real CSV profiling (dependency-light, runs inside the Worker)
// ---------------------------------------------------------------------------

const PROFILE_ROW_CAP = 5000; // sample to bound cost on large files
const MAX_EXAMPLES = 5;

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 * escaped quotes (""), and \r\n / \n line endings. Returns string[][].
 * Bounded to `maxRows` data rows (plus the header) so a huge upload can't blow up.
 */
export function parseCsv(text, maxRows = PROFILE_ROW_CAP) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let started = false; // have we begun the current field?
  const pushField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && !started) {
      inQuotes = true;
      started = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
      // stop once we have the header + maxRows data rows
      if (rows.length > maxRows) break;
    } else if (c === "\r") {
      // swallow; the \n (or EOF) ends the row
    } else {
      field += c;
      started = true;
    }
  }
  // flush a trailing field/row with no terminating newline
  if (field.length > 0 || row.length > 0 || started) pushRow();
  return rows;
}

const isBlank = (v) => v === undefined || v === null || v.trim() === "";

const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
// ISO-ish dates: 2025-04-27, 2025-04-27T09:41:00, 2025/04/27 09:41, with optional Z/offset.
const DATETIME_RE = /^\d{4}[-/]\d{2}[-/]\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const BOOL_VALUES = new Set(["true", "false", "yes", "no", "t", "f"]);

const isNumeric = (v) => NUMERIC_RE.test(v.trim());
const isDatetime = (v) => DATETIME_RE.test(v.trim());

/**
 * Leakage by NAME: post-outcome signals visible only after the prediction moment.
 * `*_at` is treated as suspicious only when it is NOT the obvious creation timestamp.
 */
const CREATION_RE = /(creat|open|start|received|submit|request|register|signup|sign_up|first_seen|join)/;

function nameLooksLeaky(name) {
  const n = name.toLowerCase();
  // Post-outcome verbs anywhere in the name (account_closed_date, ticket_resolved, ...).
  if (/(^|_)(resolved|closed|completed|finished|ended|cancelled|canceled|cancel|churned|deactivat|terminat|refund)/.test(n))
    return true;
  if (/_final$/.test(n) || /_result$/.test(n) || /_outcome$/.test(n)) return true;
  if (/^time_to_/.test(n) || /(^|_)duration($|_)/.test(n)) return true;
  if (/(^|_)(outcome|label|target|resolution|disposition)($|_)/.test(n)) return true;
  // Timestamp suffixes that postdate the prediction moment (not creation timestamps).
  if (/(_at|_date|_time|_ts|_timestamp)$/.test(n)) {
    if (CREATION_RE.test(n)) return false; // creation-ish timestamp = safe anchor
    return true;
  }
  return false;
}

function leakReasonForName(name) {
  const n = name.toLowerCase();
  if (/(^|_)(resolved|closed|completed|finished|ended|cancelled|canceled|cancel|churned|deactivat|terminat|refund)/.test(n) || /_final$/.test(n))
    return "Name suggests a post-outcome field, populated only after the event is resolved/closed.";
  if (/^time_to_/.test(n) || /(^|_)duration($|_)/.test(n))
    return "Derived from outcome timing; not known at prediction time.";
  if (/(^|_)(outcome|label|target|result|disposition)($|_)/.test(n))
    return "Name encodes the outcome/label directly.";
  if (/(_at|_date|_time|_ts|_timestamp)$/.test(n))
    return "A timestamp that postdates the prediction moment (not a creation time).";
  return "Name pattern suggests a post-outcome / target-derived field.";
}

/** Detect a creation-ish timestamp column to anchor a time-based split. */
function looksLikeCreationTime(name) {
  return /(creat|open(ed)?|start|received|submit|request|register|signup|sign_up)/i.test(name);
}

/**
 * Near-perfect separation with the target: a feature that (almost) determines the
 * label is the classic leakage smell even when its name looks innocent. We measure
 * it cheaply on the sample:
 *   - categorical/boolean: best class-purity over the feature's values (each value
 *     maps overwhelmingly to one target class);
 *   - numeric: a single threshold split's accuracy (point-biserial style separation).
 * Returns a fraction in [0,1]; >= 0.985 is treated as suspicious.
 */
function targetSeparation(values, targetValues, dtype) {
  const pairs = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const t = targetValues[i];
    if (isBlank(v) || isBlank(t)) continue;
    pairs.push([v.trim(), t.trim()]);
  }
  if (pairs.length < 20) return 0;

  if (dtype === "numeric") {
    const nums = pairs
      .map(([v, t]) => [Number(v), t])
      .filter(([x]) => Number.isFinite(x))
      .sort((a, b) => a[0] - b[0]);
    if (nums.length < 20) return 0;
    const labels = nums.map(([, t]) => t);
    const classes = [...new Set(labels)];
    if (classes.length !== 2) return 0; // only score binary targets cheaply
    const [A] = classes;
    const total = labels.length;
    const totalA = labels.filter((l) => l === A).length;
    let bestAcc = 0;
    let leftA = 0;
    for (let i = 0; i < total - 1; i++) {
      if (labels[i] === A) leftA++;
      if (nums[i][0] === nums[i + 1][0]) continue; // can't cut between equal values
      const leftN = i + 1;
      const rightN = total - leftN;
      const rightA = totalA - leftA;
      const leftAcc = Math.max(leftA, leftN - leftA);
      const rightAcc = Math.max(rightA, rightN - rightA);
      const acc = (leftAcc + rightAcc) / total;
      if (acc > bestAcc) bestAcc = acc;
    }
    return bestAcc;
  }

  // categorical / boolean: weighted purity of the best target class per feature value
  const byValue = new Map();
  for (const [v, t] of pairs) {
    let m = byValue.get(v);
    if (!m) {
      m = new Map();
      byValue.set(v, m);
    }
    m.set(t, (m.get(t) || 0) + 1);
  }
  // too many distinct values (≈ an id column) trivially separates; that's a different
  // smell (cardinality), so don't flag it as separation-leakage here.
  if (byValue.size > Math.max(50, pairs.length * 0.5)) return 0;
  let correct = 0;
  for (const m of byValue.values()) {
    let best = 0;
    for (const c of m.values()) if (c > best) best = c;
    correct += best;
  }
  return correct / pairs.length;
}

/**
 * Profile a real CSV. Returns the same profile shape `profileFor` produces, plus a
 * couple of additive fields (example_values, missing_pct, cardinality) the cockpit
 * can show. dtype ∈ {numeric, categorical, datetime, boolean, text}.
 *
 * @param {string} text       raw CSV
 * @param {object} opts       { target?, datasetId? }
 */
export function profileCsv(text, opts = {}) {
  const target = opts.target || null;
  const datasetId = opts.datasetId || "dataset";
  const rows = parseCsv(text, PROFILE_ROW_CAP);
  if (!rows.length) {
    return {
      dataset_id: datasetId,
      row_count: 0,
      target,
      target_definition: null,
      leakage_candidates: [],
      safe_features: [],
      split: { strategy: "random", ratios: [0.7, 0.15, 0.15], seed: 42 },
      columns: [],
      sampled: false,
    };
  }
  const header = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  const sampleN = dataRows.length;
  const targetIdx = target ? header.indexOf(target) : -1;
  const targetValues = targetIdx >= 0 ? dataRows.map((r) => r[targetIdx] ?? "") : [];

  const columns = [];
  const datetimeCols = [];
  const categoricalCols = [];
  const leakageCandidates = [];
  const safeFeatures = [];

  for (let ci = 0; ci < header.length; ci++) {
    const name = header[ci];
    const raw = dataRows.map((r) => (r[ci] === undefined ? "" : r[ci]));
    const present = raw.filter((v) => !isBlank(v));
    const missingFrac = sampleN ? (sampleN - present.length) / sampleN : 0;
    const uniq = new Set(present.map((v) => v.trim()));
    const cardinality = uniq.size;

    // --- dtype inference over the non-blank sample ---
    let dtype;
    const lower = [...uniq].map((v) => v.toLowerCase());
    const allBool =
      present.length > 0 && lower.every((v) => BOOL_VALUES.has(v)) && cardinality <= 2;
    const allNumeric = present.length > 0 && present.every((v) => isNumeric(v));
    const allDatetime = present.length > 0 && present.every((v) => isDatetime(v));
    if (allBool) {
      dtype = "boolean";
    } else if (allDatetime) {
      dtype = "datetime";
    } else if (allNumeric) {
      dtype = "numeric";
    } else {
      // strings: few distinct values ⇒ categorical; many ⇒ free text.
      const ratio = present.length ? cardinality / present.length : 1;
      dtype = cardinality <= 50 && ratio < 0.5 ? "categorical" : "text";
    }

    if (dtype === "datetime") datetimeCols.push(name);
    if (dtype === "categorical" || dtype === "boolean") categoricalCols.push(name);

    // --- leakage inference: name patterns OR near-perfect target separation ---
    const isTarget = name === target;
    let isLeak = false;
    let leakReason;
    if (!isTarget) {
      if (nameLooksLeaky(name)) {
        isLeak = true;
        leakReason = leakReasonForName(name);
      } else if (
        targetIdx >= 0 &&
        targetIdx !== ci &&
        // Separation is only meaningful for value-like features (numeric / category /
        // boolean), NOT timestamps (which trivially separate) and NOT id-like columns
        // (near-unique values trivially separate; that's a cardinality smell, not leakage).
        (dtype === "numeric" || dtype === "categorical" || dtype === "boolean") &&
        !(cardinality > 50 || (present.length >= 20 && cardinality / present.length > 0.3))
      ) {
        const sep = targetSeparation(raw, targetValues, dtype);
        if (sep >= 0.985) {
          isLeak = true;
          leakReason =
            `Almost perfectly separates the target (${(sep * 100).toFixed(1)}% on the sample); ` +
            "near-deterministic features are usually post-outcome leakage.";
        }
      }
    }

    const examples = [...uniq].slice(0, MAX_EXAMPLES);
    const col = {
      name,
      dtype,
      missing_fraction: round4(missingFrac),
      missing_pct: round4(missingFrac * 100),
      cardinality,
      n_unique: cardinality,
      example_values: examples,
      is_candidate_leakage: isLeak,
    };
    if (leakReason) col.leakage_reason = leakReason;
    columns.push(col);

    if (isLeak) leakageCandidates.push(name);
    else if (!isTarget) safeFeatures.push(name);
  }

  // --- suggested split: time-based on a creation timestamp if one exists ---
  const timeCol =
    datetimeCols.find((c) => looksLikeCreationTime(c) && !leakageCandidates.includes(c)) ||
    datetimeCols.find((c) => !leakageCandidates.includes(c)) ||
    null;
  const split = timeCol
    ? { strategy: "time_based", time_col: timeCol, ratios: [0.7, 0.15, 0.15], seed: 42 }
    : { strategy: "random", ratios: [0.7, 0.15, 0.15], seed: 42 };

  return {
    dataset_id: datasetId,
    row_count: sampleN, // rows observed in the (possibly sampled) CSV
    target,
    target_definition: null, // a real definition comes from the human checkpoint
    leakage_candidates: leakageCandidates,
    safe_features: safeFeatures,
    categorical_features: categoricalCols,
    datetime_columns: datetimeCols,
    split,
    columns,
    sampled: dataRows.length >= PROFILE_ROW_CAP,
  };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Derive a deterministic, baseline-first, TASK-APPROPRIATE hypothesis library from a
 * REAL resolved profile (profileCsv output for an uploaded dataset). Unlike
 * `hypothesisLibrary` — which is hand-written for the bundled `sla_tickets` golden path
 * and references sla-specific columns — this works for arbitrary tabular data:
 *
 *   - the first card is ALWAYS the baseline (dummy + logistic/linear) on the profile's
 *     SAFE features, with a rationale that it sets the floor every later run must clear;
 *   - then a small set of model-family cards keyed to the inferred task type
 *     (classification ⇒ logistic_regression, random_forest, hist_gradient_boosting, plus
 *     a threshold-calibration card; regression ⇒ linear, random_forest,
 *     hist_gradient_boosting);
 *   - every card uses ONLY safe features (leakage/banned columns are excluded by
 *     construction — `safeFeatures` already omits them) and references the study's target
 *     + primary metric.
 *
 * Deterministic: same profile + opts ⇒ identical cards (no clock, no randomness).
 *
 * @param {object} profile  resolved dataset profile (profileCsv output)
 * @param {object} opts     { taskType, target, metric, bannedColumns? }
 * @returns hypothesis cards in the same shape as `hypothesisLibrary`.
 */
export function generatedHypothesisLibrary(profile, opts = {}) {
  const taskType = opts.taskType || "binary_classification";
  const isRegression = taskType === "regression";
  const target = opts.target || profile.target || "the target";
  const metric = opts.metric || (isRegression ? "rmse" : "recall");

  // SAFE features only: the profile's safe_features already excludes the target and every
  // leakage candidate. Union any caller-declared banned columns out as a belt-and-braces
  // guard so a generated card can NEVER name a banned/leaky column. Deterministic order.
  const banned = new Set([...(opts.bannedColumns || []), ...(profile.leakage_candidates || [])]);
  const safe = (profile.safe_features || []).filter((n) => n && n !== target && !banned.has(n));

  // A short, human-readable feature blurb for rationales (first few, then "+N more").
  const blurb = (() => {
    if (!safe.length) return "the available safe features";
    const head = safe.slice(0, 3).join(", ");
    const extra = safe.length - 3;
    return extra > 0 ? `${head} (+${extra} more)` : head;
  })();

  const cards = [];

  if (isRegression) {
    cards.push({
      statement:
        `A dummy + linear-regression baseline establishes the ${metric} floor on \`${target}\`; ` +
        "no tuned model should be trusted until it beats this reference.",
      rationale:
        "Baselines first: a mean predictor plus a plain linear model is the cheapest honest " +
        `reference and anchors every later comparison (features: ${blurb}).`,
      model_family: "linear_regression",
      features: safe,
      expected_outcome: `A modest ${metric}; the number every other run must beat.`,
      tags: ["baseline"],
    });
    cards.push({
      statement:
        `Random forests capture nonlinear feature interactions a linear baseline misses, ` +
        `improving ${metric} on \`${target}\`.`,
      rationale:
        "Tabular targets are often interaction-heavy; trees model feature crosses without " +
        "manual engineering.",
      model_family: "random_forest",
      features: safe,
      expected_outcome: `${metric} improves over the linear baseline.`,
      tags: [],
    });
    cards.push({
      statement:
        `Histogram gradient boosting fits residual structure the forest leaves behind, giving ` +
        `the best ${metric} of the family on \`${target}\`.`,
      rationale:
        "Boosting usually edges out bagging on tabular regression; worth one capacity test " +
        "against the baseline.",
      model_family: "hist_gradient_boosting",
      features: safe,
      expected_outcome: `Best ${metric} of the linear/tree family.`,
      tags: [],
    });
  } else {
    cards.push({
      statement:
        `A dummy + logistic-regression baseline establishes the ${metric} floor on \`${target}\`; ` +
        "no tuned model should be trusted until it clears this bar.",
      rationale:
        "Baselines first: a majority-class dummy plus a calibrated linear model is the cheapest " +
        `honest reference and anchors every later comparison (features: ${blurb}).`,
      model_family: "logistic_regression",
      features: safe,
      expected_outcome: `A modest ${metric}; the number every other run must beat.`,
      tags: ["baseline"],
    });
    cards.push({
      statement:
        `Random forests capture nonlinear interactions a linear baseline misses, improving ` +
        `${metric} on \`${target}\` at a fixed error budget.`,
      rationale:
        "Class boundaries are often interaction-heavy; trees model feature crosses without " +
        "manual engineering.",
      model_family: "random_forest",
      features: safe,
      expected_outcome: `${metric} lifts over baseline while guardrails hold.`,
      tags: [],
    });
    cards.push({
      statement:
        `Histogram gradient boosting ranks risk better and produces better-calibrated ` +
        `probabilities, raising ${metric} on \`${target}\` once the threshold is tuned on validation.`,
      rationale:
        "Boosting usually ranks better than bagging on tabular data; calibration matters when " +
        "the metric is threshold-dependent.",
      model_family: "hist_gradient_boosting",
      features: safe,
      expected_outcome: `Best ranking of the family; strongest ${metric}.`,
      tags: [],
    });
    cards.push({
      statement:
        `Threshold calibration on the validation split lets us hit the ${metric} target while ` +
        "respecting the guardrails, rather than accepting the default 0.5 cutoff.",
      rationale:
        "The decision threshold is the real lever for a threshold-dependent metric and must be " +
        "chosen on validation, never test.",
      model_family: "hist_gradient_boosting",
      features: safe,
      expected_outcome: `Same model, higher usable ${metric} after validation-tuned thresholding.`,
      tags: ["calibration"],
    });
  }

  return cards;
}

/**
 * A deterministic, hypothesis-driven experiment library (NOT a parameter sweep).
 * Each card is a falsifiable claim with a rationale, a model family, the safe
 * feature set it would use, and an expected outcome. The first card is always the
 * baseline (the rubric requires a baseline before anything tuned).
 */
export function hypothesisLibrary(profile) {
  const all = profile.safe_features;
  const f = (...names) => names.filter((n) => all.includes(n));
  return [
    {
      statement:
        "A dummy + logistic-regression baseline establishes the recall floor at FPR<=0.20; " +
        "no tuned model should be trusted until it clears this bar.",
      rationale:
        "Baselines first: a calibrated linear model is the cheapest honest reference and " +
        "anchors every later comparison.",
      model_family: "logistic_regression",
      features: all,
      expected_outcome: "Modest recall at FPR<=0.20; the number every other run must beat.",
      tags: ["baseline"],
    },
    {
      statement:
        "Random forests capture nonlinear interactions between queue_depth_at_creation and " +
        "priority that a linear baseline misses, improving recall at fixed FPR.",
      rationale:
        "Breach risk is plausibly interaction-heavy (a high-priority ticket in a deep queue), " +
        "which trees model without manual feature crosses.",
      model_family: "random_forest",
      features: all,
      expected_outcome: "Recall lifts a few points over baseline while FPR stays within guardrail.",
      tags: [],
    },
    {
      statement:
        "Histogram gradient boosting produces better-calibrated breach probabilities, raising " +
        "recall once the threshold is tuned on validation.",
      rationale:
        "Boosting usually ranks risk better than bagging on tabular data; calibration matters " +
        "because the metric is recall at a fixed FPR.",
      model_family: "hist_gradient_boosting",
      features: all,
      expected_outcome: "Best PR-AUC of the linear/tree family; strongest recall at FPR<=0.20.",
      tags: [],
    },
    {
      statement:
        "Queue depth and priority alone carry most of the breach signal; a compact model on just " +
        "those stays interpretable with little recall loss.",
      rationale:
        "The brief prefers a trustworthy, reproducible model; an interpretable subset is worth " +
        "testing for an acceptable recall trade-off.",
      model_family: "random_forest",
      features: f("queue_depth_at_creation", "priority", "customer_tier"),
      expected_outcome: "Slightly lower recall than the full model, but far easier to explain.",
      tags: [],
    },
    {
      statement:
        "Reopened tickets and reporters with little history are higher-risk; emphasising " +
        "is_reopen and reporter_history_count lifts enterprise-segment recall.",
      rationale:
        "Enterprise breaches cost more (segment requirement); features that flag fragile cases " +
        "should help where it matters most.",
      model_family: "logistic_regression",
      features: f("is_reopen", "reporter_history_count", "customer_tier", "priority", "queue_depth_at_creation"),
      expected_outcome: "Enterprise-segment recall improves without breaching the FPR guardrail.",
      tags: [],
    },
    {
      statement:
        "Threshold calibration on the validation split lets us hit the recall target while " +
        "holding FPR<=0.20, rather than accepting the default 0.5 cutoff.",
      rationale:
        "The decision threshold is the real lever for a recall-at-FPR metric and must be chosen " +
        "on validation, never test.",
      model_family: "hist_gradient_boosting",
      features: all,
      expected_outcome: "Same model, higher usable recall after validation-tuned thresholding.",
      tags: [],
    },
    {
      statement:
        "Channel and business-hours interactions shift breach risk; gradient boosting exploits " +
        "them for an additional recall gain.",
      rationale:
        "Off-hours tickets on slow channels may breach more often; boosting can pick up these " +
        "conditional effects.",
      model_family: "hist_gradient_boosting",
      features: f("channel", "business_hours_flag", "priority", "queue_depth_at_creation", "product_area", "region"),
      expected_outcome: "Marginal recall gain; useful mainly if it survives the calibration check.",
      tags: [],
    },
    {
      statement:
        "A higher-capacity booster (LightGBM) improves PR-AUC slightly but risks overfitting the " +
        "newest tickets; it must be judged against the baseline and a calibration check.",
      rationale:
        "Worth one capacity-vs-robustness test, but the brief weights trust over a marginally " +
        "higher score.",
      model_family: "lightgbm",
      features: all,
      expected_outcome: "Best raw ranking, but watch for a calibration/robustness critique.",
      tags: [],
    },
  ];
}
