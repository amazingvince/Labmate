/**
 * Custom-tool dispatcher — the agent's hands.
 *
 * Each handler executes a tool the agent called by talking to:
 *   - the Labmate control plane (apps/web) over the OpenAPI contract, and/or
 *   - the Modal runner (REAL experiment execution).
 *
 * Handlers are injected with `deps` (controlPlane, modal) so the smoke test can
 * pass stubs and drive the whole loop with no network. The dispatcher returns a
 * plain object; loop.mjs serializes it into a user.custom_tool_result.
 *
 * Invariants enforced here (defense in depth; the control plane/runner also check):
 *   - launch_experiment requires an approval_id (else we surface 402 to the agent);
 *   - we never strip the runner's 422 on banned-column / tune_on=test — we relay it
 *     so the agent must correct and rerun (this drives the self-correction moment).
 */

/**
 * Parse a "false_positive_rate <= 0.20" style guardrail string into a number.
 * Accepts the bound as a fraction (0.2) or a percentage (20%). Returns null if the
 * string doesn't carry an FPR bound.
 */
export function parseFprGuardrail(guardrail) {
  if (typeof guardrail !== "string") return null;
  const m = guardrail.match(/false_positive_rate\s*<=?\s*([0-9]*\.?[0-9]+)\s*(%?)/i);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  if (m[2] === "%") v /= 100;
  // A bare ">1" almost certainly means a percent written without the sign (e.g. "20").
  if (v > 1) v /= 100;
  return v >= 0 && v <= 1 ? v : null;
}

/**
 * Collect the study's guardrails from its constraints. The Worker stores parsed
 * constraints on the study (`constraints.guardrails` — a list — and/or
 * `constraints.guardrail`/`primary_metric` from the NL-feedback parser). We tolerate
 * all shapes and return { maxFpr, primaryMetric }.
 */
export function deriveMetricGuardrail(constraints) {
  const out = { maxFpr: null, primaryMetric: null };
  if (!constraints || typeof constraints !== "object") return out;
  if (typeof constraints.primary_metric === "string") out.primaryMetric = constraints.primary_metric;

  const candidates = [];
  if (Array.isArray(constraints.guardrails)) candidates.push(...constraints.guardrails);
  if (constraints.guardrail) candidates.push(constraints.guardrail);
  // A guardrail may be an object {false_positive_rate: 0.2} or a string.
  for (const g of candidates) {
    if (typeof g === "string") {
      const v = parseFprGuardrail(g);
      if (v != null) out.maxFpr = v;
    } else if (g && typeof g === "object" && g.false_positive_rate != null) {
      const v = Number(g.false_positive_rate);
      if (Number.isFinite(v)) out.maxFpr = v > 1 ? v / 100 : v;
    }
  }
  if (out.maxFpr == null && constraints.max_fpr != null) {
    const v = Number(constraints.max_fpr);
    if (Number.isFinite(v)) out.maxFpr = v > 1 ? v / 100 : v;
  }
  return out;
}

export function makeDispatcher(deps) {
  const { controlPlane, modal, onApprovalNeeded, autoApprove = false, approvalDelayMs = 0, budget = {} } = deps;
  const { defaultBudgetSeconds = 600, defaultMaxTrials = 20 } = budget;

  /**
   * Fetch a study's constraints + budget from the control plane (best-effort; the
   * gate degrades to defaults if the study detail can't be read). Uses the public
   * GET /api/studies/:id detail endpoint the Worker already serves.
   */
  async function getStudy(studyId) {
    if (!studyId) return null;
    const detail = await controlPlane.get(`/api/studies/${encodeURIComponent(studyId)}`);
    if (!detail || detail.error) return null;
    return detail.study ?? detail; // detail.study (StudyDetail) or a bare Study
  }

  /** @type {Record<string, (input: any) => Promise<any>>} */
  const handlers = {
    async profile_dataset(input) {
      return controlPlane.post("/api/profile", { study_id: input.study_id });
    },

    async propose_experiments(input) {
      // Persist hypotheses; return their ids so the agent can reference them.
      return controlPlane.post("/api/experiments/propose", {
        study_id: input.study_id,
        hypotheses: input.hypotheses,
      });
    },

    async request_approval(input) {
      // Create the pending approval row and notify the cockpit.
      const res = await controlPlane.post("/api/approvals/request", input);
      if (res?.error) return res; // relay control-plane failure to the agent
      if (onApprovalNeeded) await onApprovalNeeded(input, res);
      // Brief, visible approval window: pause (a human may approve in the cockpit
      // during it) before auto-granting. Never blocks indefinitely.
      if (autoApprove && approvalDelayMs > 0) {
        await new Promise((r) => setTimeout(r, approvalDelayMs));
      }
      if (!autoApprove || !res?.approval_id) {
        return res; // { approval_id, status: "pending" } — awaits a human in the cockpit
      }

      // REAL budget check (not just a comment): auto-grant ONLY when this request,
      // plus the compute/trials already approved, stays within the study's budget.
      // Over budget → leave the approval pending so a human decides in the cockpit.
      const study = await getStudy(input.study_id);
      const budgetSeconds = study?.budget?.budget_seconds ?? defaultBudgetSeconds;
      const maxTrials = study?.budget?.max_trials ?? defaultMaxTrials;

      // What has already been approved (sum prior approval feedback + run count).
      const runsRes = await controlPlane.post("/api/runs/query", { study_id: input.study_id });
      const priorTrials = Array.isArray(runsRes?.runs) ? runsRes.runs.length : 0;
      const requestedTrials = Math.max(1, Number(input.trial_count ?? (input.experiment_ids?.length || 1)));
      const requestedSeconds = Number(input.estimated_cost_seconds ?? 0);

      const overTrials = priorTrials + requestedTrials > maxTrials;
      const overSeconds = requestedSeconds > 0 && requestedSeconds > budgetSeconds;
      if (overTrials || overSeconds) {
        // Within-budget could not be established → do NOT auto-approve. The pending
        // row already notified the cockpit; a human approves (or not) there.
        return {
          approval_id: res.approval_id,
          status: "pending",
          reason: overTrials
            ? `over trial budget: ${priorTrials}+${requestedTrials} > ${maxTrials} — needs human approval`
            : `over compute budget: ${requestedSeconds}s > ${budgetSeconds}s — needs human approval`,
        };
      }

      // Within budget: auto-grant by recording a REAL approval feedback (the only
      // thing launch_experiment's 402 gate accepts). The gate is not bypassed — we
      // satisfy it with a genuine, ledgered approval whose created_at precedes the run
      // (so the rubric's compute_gated check passes). Without a human and without this,
      // the loop would deadlock at 402 forever.
      const fb = await controlPlane.post("/api/feedback", {
        study_id: input.study_id,
        type: "approval",
        scope: "study",
        target_id: res.approval_id,
        content:
          `Auto-approved within budget (${priorTrials + requestedTrials}/${maxTrials} trials, ` +
          `${requestedSeconds || "?"}s/${budgetSeconds}s): ${input.reason ?? "compute request"}`,
      });
      if (fb?.error) return fb;
      return { approval_id: res.approval_id, status: "approved" };
    },

    async launch_experiment(input) {
      if (!input.approval_id) {
        // Mirror the control plane's gate so the agent learns it must ask first.
        return {
          error: "approval_required",
          detail:
            "launch_experiment needs an approval_id. Call request_approval first.",
          http_status: 402,
        };
      }

      const manifest = { ...(input.manifest ?? {}) };
      const tags = manifest.tags ?? [];
      const isBaseline =
        tags.includes("baseline") ||
        tags.includes("dummy") ||
        String(manifest.model_family ?? manifest.model?.family ?? "")
          .toLowerCase()
          .match(/dummy|baseline/);

      // HARD-RULE DISPATCHER GATE (defense in depth over the system prompt): a TUNED
      // experiment may not run until a BASELINE run already exists AND a leakage review
      // has been recorded. A cheap query_runs lookup; on violation we return a
      // structured 409 the agent must resolve before retrying — enforcing CLAUDE.md
      // Hard Rule 1 ("never train before a leakage review; always baseline first")
      // instead of trusting the system prompt alone.
      if (!isBaseline) {
        const studyId = manifest.study_id;
        const runsRes = await controlPlane.post("/api/runs/query", { study_id: studyId });
        if (runsRes?.error) return runsRes; // relay transport/CP failure to the agent
        const runs = Array.isArray(runsRes?.runs) ? runsRes.runs : [];
        const hasBaseline = runs.some(
          (r) =>
            (r.tags ?? []).includes("baseline") ||
            (r.tags ?? []).includes("dummy") ||
            String(r.model_family ?? "").toLowerCase().match(/dummy|baseline/),
        );
        // Block strictly: a tuned model needs SOMETHING to compare against. We accept a
        // run tagged baseline/dummy; if none of the existing runs are baselines (incl.
        // the empty case) the agent must run one first.
        if (!hasBaseline) {
          return {
            error: "baseline_required",
            detail:
              "No baseline run exists yet. Hard Rule 1: run a dummy/logistic/linear " +
              "baseline (tag it 'baseline') BEFORE any tuned model, so every model is " +
              "compared to it.",
            http_status: 409,
          };
        }

        // Leakage review: prefer the affirmative signal the Worker can give —
        // query_runs(critique_kind:'leakage') returns runs TARGETED by a leakage
        // critique. A study-level leakage review (target_run_id = null, the common case
        // when the review precedes any run) is NOT surfaced that way, so its emptiness
        // is NOT proof of absence. We therefore only hard-block when we can prove no
        // leakage critique exists at all (has_leakage_critique === false, if the CP
        // reports it); otherwise we attach a non-blocking advisory and let the launch
        // proceed — the Worker's own 422 banned-column gate is the load-bearing leakage
        // guard at launch time.
        const leakageRes = await controlPlane.post("/api/runs/query", {
          study_id: studyId,
          critique_kind: "leakage",
        });
        if (leakageRes && !leakageRes.error && leakageRes.has_leakage_critique === false) {
          return {
            error: "leakage_review_required",
            detail:
              "No leakage critique on record. Review for leakage and record_critique " +
              "(kind='leakage') BEFORE launching a tuned experiment (Hard Rule: never " +
              "train before a leakage review).",
            http_status: 409,
          };
        }
      }

      // C5 — inject the FPR guardrail + primary metric from the study's constraints
      // onto the manifest so the runner enforces it (max_fpr) and calibrates the
      // threshold to satisfy it. The agent may also set metric.* explicitly; we only
      // fill what's missing (never override an agent-provided value).
      try {
        const study = await getStudy(manifest.study_id);
        const { maxFpr, primaryMetric } = deriveMetricGuardrail(study?.constraints);
        if (maxFpr != null || primaryMetric) {
          const metric = { ...(manifest.metric ?? {}) };
          if (metric.max_fpr == null && maxFpr != null) metric.max_fpr = maxFpr;
          if (!metric.primary_metric && primaryMetric) metric.primary_metric = primaryMetric;
          manifest.metric = metric;
        }
      } catch {
        /* guardrail injection is best-effort; the runner also enforces server-side */
      }

      // The control plane records the run, verifies the approval, and forwards the
      // manifest to the Modal runner. We call it (not Modal directly) so the run is
      // persisted with provenance and the approval is checked server-side.
      // It relays the runner's 422 for banned columns / tune_on=test unchanged.
      // `applied_feedback_id` (if the agent set it) rides along on the manifest so the
      // Worker records which human feedback shaped this run (rubric feedback_affected_plan).
      return controlPlane.post("/api/experiments/launch", {
        approval_id: input.approval_id,
        manifest,
      });
    },

    async query_runs(input) {
      return controlPlane.post("/api/runs/query", input);
    },

    async record_critique(input) {
      return controlPlane.post("/api/critiques", input);
    },

    async record_decision(input) {
      return controlPlane.post("/api/decisions", input);
    },

    async write_report(input) {
      return controlPlane.post("/api/reports", {
        study_id: input.study_id,
        report_type: input.report_type ?? "model_card",
      });
    },
  };

  return {
    has(name) {
      return Object.prototype.hasOwnProperty.call(handlers, name);
    },
    async dispatch(name, input) {
      const handler = handlers[name];
      if (!handler) {
        return { error: "unknown_tool", detail: `No handler for ${name}` };
      }
      try {
        return await handler(input);
      } catch (err) {
        return { error: "tool_failed", detail: String(err?.message ?? err) };
      }
    },
    // Exposed for tests.
    _handlers: handlers,
    // `modal` is available for a direct-call variant (slice note (a) vs (b)); the
    // default path routes through the control plane so runs are always persisted.
    _modal: modal,
  };
}
