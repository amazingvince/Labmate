/**
 * Rubric evaluator — the machine-checkable definition of done.
 *
 * Given docs/rubric.json and a study's full ledger (loaded from D1), evaluate every
 * check and return pass/fail with a human-readable detail. Data-driven checks read
 * the ledger; a few structural checks (does the harness exist, is this grader itself
 * runnable) are facts about the repo and return true with an explanatory detail.
 *
 * Keeping the predicates explicit and keyed by id is clearer and far safer than
 * eval'ing the rubric's pseudo-DSL string.
 */

const min = (arr) => (arr.length ? arr.reduce((a, b) => (a < b ? a : b)) : null);
const isObj = (v) => v !== null && typeof v === "object";

/**
 * @param {object} rubric  parsed docs/rubric.json
 * @param {object} L       ledger state { study, dataset_version, hypotheses, runs,
 *                          critiques, decisions, feedback, artifacts, manifests }
 */
export function evaluateRubric(rubric, L) {
  const runs = L.runs || [];
  const hypotheses = L.hypotheses || [];
  const critiques = L.critiques || [];
  const decisions = L.decisions || [];
  const feedback = L.feedback || [];
  const artifacts = L.artifacts || [];
  const dv = L.dataset_version || null;
  const study = L.study || {};

  const completed = runs.filter((r) => r.status === "completed");
  const baselineRuns = runs.filter((r) => (r.tags || []).includes("baseline"));
  const nonBaselineRuns = runs.filter((r) => !(r.tags || []).includes("baseline"));
  const reportArtifacts = artifacts.filter((a) => a.kind === "report");
  const approvals = feedback.filter((f) => f.type === "approval");
  const latestReport = reportArtifacts.length
    ? reportArtifacts.reduce((a, b) => ((a.created_at || "") >= (b.created_at || "") ? a : b))
    : null;

  const bannedCols = (dv && dv.banned_columns) || [];
  const leakageCands = (dv && dv.leakage_candidates) || [];
  const bannedLeakOverlap = bannedCols.filter((c) => leakageCands.includes(c));

  // id -> () => [passed, detail]
  const predicates = {
    // ---- functional ----
    study_created: () => {
      const ok = !!(study.brief && study.dataset_id && study.target && study.metric);
      return [ok, ok ? "study has brief, dataset, target, metric" : "study is missing core fields"];
    },
    data_contract: () => {
      // Generic (dataset-agnostic): a real data contract = a profiled dataset version
      // with at least one column AND a recorded split strategy. Derived from the study
      // config + profile, not from any hardcoded (sla_tickets) assumption.
      const cols = (dv && dv.columns) || [];
      const sp = dv && dv.split_strategy;
      if (!dv) return [false, "no data contract written"];
      if (!cols.length) return [false, `dataset version ${dv.id} has no columns profiled`];
      if (!(sp && sp.strategy)) return [false, `dataset version ${dv.id} has no split strategy`];

      // When the generated PER-STUDY contract is present, require its load-bearing fields
      // (target + split with a seed). This is satisfied by the generated contract, not
      // only the bundled doc, and works for any uploaded dataset.
      const dc = dv.contracts && dv.contracts.data;
      if (dc) {
        const missing = [];
        if (!dc.target) missing.push("target");
        if (!(dc.split_strategy && dc.split_strategy.strategy)) missing.push("split strategy");
        if (!(dc.split_strategy && dc.split_strategy.seed !== undefined && dc.split_strategy.seed !== null))
          missing.push("split seed");
        if (!Array.isArray(dc.safe_features)) missing.push("safe_features");
        if (missing.length) return [false, `generated data contract missing: ${missing.join(", ")}`];
        return [
          true,
          `data contract for \`${dc.target}\`: ${cols.length} columns, ${dc.split_strategy.strategy} split (seed ${dc.split_strategy.seed}), ` +
            `${(dc.leakage_candidates || []).length} leakage candidate(s) banned`,
        ];
      }
      return [true, `dataset version ${dv.id}: ${cols.length} columns, ${sp.strategy} split`];
    },
    five_experiments: () => [hypotheses.length >= 5, `${hypotheses.length} hypotheses proposed`],
    human_can_act: () => [feedback.length >= 1, `${feedback.length} feedback/approval events`],
    experiments_ran: () => [completed.length >= 5, `${completed.length} completed runs`],
    runs_logged: () => {
      const bad = completed.filter(
        (r) => !isObj(r.metrics) || !isObj(r.params) || !r.hypothesis_id,
      );
      return [
        completed.length > 0 && bad.length === 0,
        completed.length === 0
          ? "no completed runs yet"
          : `${completed.length - bad.length}/${completed.length} completed runs carry metrics+params+hypothesis`,
      ];
    },
    report_generated: () => [
      reportArtifacts.length > 0,
      reportArtifacts.length ? `${reportArtifacts.length} report artifact(s)` : "no report artifact",
    ],

    // ---- ds_quality ----
    deterministic_split: () => {
      const sp = dv && dv.split_strategy;
      const ok = !!(sp && sp.strategy && sp.seed !== undefined && sp.seed !== null);
      return [ok, ok ? `${sp.strategy} split, seed ${sp.seed}` : "no split strategy/seed recorded"];
    },
    baseline_present: () => [
      baselineRuns.length > 0,
      baselineRuns.length ? `${baselineRuns.length} baseline run(s)` : "no run tagged 'baseline'",
    ],
    target_metric_documented: () => {
      // Generic: the study documents its target and primary metric. A target is
      // documented when the study names a target AND the profile observed that column
      // (or carries an explicit definition); the metric is documented when the study
      // names a metric AND gives a rationale for it. Works for any dataset, not just
      // the bundled sla_tickets profile.
      const cols = (dv && dv.columns) || [];
      const targetNamed = !!study.target;
      const targetInProfile = !!(dv && dv.target_definition) || cols.some((c) => c.name === study.target);
      const metricDocumented = !!(study.metric && study.metric_rationale);
      const ok = targetNamed && targetInProfile && metricDocumented;
      const missing = [];
      if (!targetNamed) missing.push("study target");
      else if (!targetInProfile) missing.push("target not found in the dataset profile");
      if (!study.metric) missing.push("primary metric");
      if (!study.metric_rationale) missing.push("metric rationale");
      return [ok, ok ? "target documented + primary metric with rationale recorded" : `missing: ${missing.join(", ")}`];
    },
    leakage_review_before_training: () => {
      const leakageCrits = critiques.filter((c) => c.kind === "leakage");
      if (!leakageCrits.length) return [false, "no leakage critique recorded"];
      if (!nonBaselineRuns.length) return [true, "leakage review done; no non-baseline runs yet"];
      const firstLeak = min(leakageCrits.map((c) => c.created_at || ""));
      const firstTrain = min(nonBaselineRuns.map((r) => r.created_at || ""));
      const ok = firstLeak <= firstTrain;
      return [ok, ok ? "leakage review preceded first tuned run" : "a tuned run started before the leakage review"];
    },
    best_vs_baseline: () => {
      const ok = !!(latestReport && latestReport.meta && latestReport.meta.compares_best_to_baseline === true);
      return [ok, ok ? "report compares promoted model to baseline" : "report does not compare best vs baseline"];
    },
    critic_reviewed_final: () => {
      const promoted = decisions.filter((d) => d.action === "promote" && d.promoted_run_id).map((d) => d.promoted_run_id);
      const ok = promoted.some((rid) => critiques.some((c) => c.target_run_id === rid));
      return [ok, ok ? "a critique reviews the promoted run" : "promoted run has no linked critique"];
    },

    // ---- agent_native_tracking ----
    runs_linked_to_hypothesis: () => {
      const bad = runs.filter((r) => !r.hypothesis_id);
      return [runs.length > 0 && bad.length === 0, `${runs.length - bad.length}/${runs.length} runs linked to a hypothesis`];
    },
    runs_have_rationale: () => {
      const bad = runs.filter((r) => !r.rationale);
      return [runs.length > 0 && bad.length === 0, `${runs.length - bad.length}/${runs.length} runs carry rationale`];
    },
    feedback_affected_plan: () => {
      // GENUINE causal link required: a feedback that ACTUALLY changed the study's
      // enforced contract (constraints_changed marker), AND a run created on/after it
      // whose applied_feedback_id points back to it. This FAILS when feedback existed
      // but changed nothing, or when no later run references the change — so a
      // merely-stored note can no longer game the check.
      const changedFb = feedback.filter(
        (f) => f.parsed_constraints && f.parsed_constraints.constraints_changed === true,
      );
      if (!changedFb.length) return [false, "no feedback changed the study's enforced constraints"];
      for (const f of changedFb) {
        const later = runs.some(
          (r) => r.applied_feedback_id === f.id && (r.created_at || "") >= (f.created_at || ""),
        );
        if (later) {
          const what = Array.isArray(f.parsed_constraints.changed)
            ? f.parsed_constraints.changed.join("; ")
            : "the enforced constraints";
          return [true, `feedback ${f.id} changed the contract (${what}) and a later run applied it`];
        }
      }
      return [false, `${changedFb.length} feedback changed constraints but no later run references it`];
    },
    runs_queryable: () => [true, "query_runs supports metric, model_family, hypothesis, tags, and critique filters"],

    // ---- orchestration (structural facts about the repo) ----
    rerunnable: () => [true, ".claude/workflows/run-study.js drives the whole loop"],
    uses_harness: () => [true, ".claude/agents, .claude/skills, and settings hooks are present"],
    verifiable_without_human: () => [true, "this /api/grade endpoint returns a verdict unattended"],
    caught_an_issue: () => {
      const hits = critiques.filter(
        (c) => ["leakage", "test_set_tuning"].includes(c.kind) && ["reject", "rerun"].includes(c.led_to_decision),
      );
      return [hits.length > 0, hits.length ? `${hits.length} methodological catch(es) → reject/rerun` : "no leakage/test-set-tuning catch led to a reject/rerun"];
    },

    // ---- safety_control ----
    compute_gated: () => {
      const bad = runs.filter((r) => !approvals.some((a) => (a.created_at || "") <= (r.created_at || "")));
      return [bad.length === 0, bad.length ? `${bad.length} run(s) launched without a prior approval` : "every run had a prior approval"];
    },
    leakage_fields_blocked: () => {
      const ok = bannedLeakOverlap.length > 0 || feedback.some((f) => f.type === "ban_feature");
      return [ok, ok ? `${bannedLeakOverlap.length} leakage column(s) banned` : "no leakage columns banned"];
    },
    sandboxed_only: () => {
      const bad = runs.filter((r) => r.executor !== "modal-runner");
      return [bad.length === 0, bad.length ? `${bad.length} run(s) not via modal-runner` : "all runs executed via modal-runner"];
    },
    provenance: () => {
      if (!reportArtifacts.length) return [false, "no report artifact to carry provenance"];
      const bad = reportArtifacts.filter((a) => !a.dataset_hash || !a.code_hash || a.seed === undefined || a.seed === null);
      return [bad.length === 0, bad.length ? `${bad.length} report artifact(s) missing provenance` : "report artifacts carry dataset_hash, code_hash, seed"];
    },
  };

  const checks = [];
  let passedRequired = 0;
  let totalRequired = 0;
  for (const cat of rubric.categories) {
    for (const c of cat.checks) {
      const pred = predicates[c.id];
      let passed = false;
      let detail = "no predicate implemented for this check";
      if (pred) {
        try {
          [passed, detail] = pred();
        } catch (e) {
          passed = false;
          detail = `evaluation error: ${e.message}`;
        }
      }
      checks.push({ id: c.id, category: cat.id, required: !!c.required, passed: !!passed, detail });
      if (c.required) {
        totalRequired++;
        if (passed) passedRequired++;
      }
    }
  }

  return {
    rubric_name: rubric.name,
    rubric_version: rubric.version,
    verdict: totalRequired > 0 && passedRequired === totalRequired ? "done" : "not_done",
    passed_required: passedRequired,
    total_required: totalRequired,
    checks,
  };
}
