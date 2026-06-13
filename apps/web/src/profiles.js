/**
 * Bundled dataset profiles + a deterministic hypothesis library.
 *
 * profile_dataset normally inspects the CSV; for the bundled `sla_tickets` golden
 * path we ship a known-good profile so the demo is deterministic and offline. It
 * mirrors docs/data_contract.md exactly (target, leakage candidates, split, seed).
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
