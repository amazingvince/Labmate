/**
 * E2E local driver — PROVES, with the real LLM agent in the loop, that human feedback
 * CAUSALLY tightens what subsequent experiments enforce.
 *
 * It creates the golden sla_tickets study (FPR guardrail <= 0.20) against the LOCAL
 * control plane — which kicks the agent-runtime (Anthropic Managed Agents) session. The
 * LLM agent profiles, proposes, launches, critiques, decides, and reports; we NEVER POST
 * manifests. Then, MID-RUN (as soon as the FIRST completed run exists), it records human
 * business feedback "tighten the false-positive-rate guardrail to 0.10" through the SAME
 * channel a human would use in the cockpit:
 *
 *   - POST /api/feedback  (record_human_feedback) — the channel that now MUTATES
 *     study.constraints (mergeStudyConstraints) and stamps constraints_changed.
 *   - POST /api/studies/{id}/message — injects the note as a steering message so the
 *     agent sees it too.
 *
 * Because both launch paths in the Worker read study.constraints on EVERY launch and
 * thread the FPR bound to the runner as declared.max_fpr (which the shim now echoes back
 * as run.metrics.max_fpr), we can OBSERVE, per run, the bound that was in force when it
 * launched. The proof:
 *
 *   baseline run (pre-feedback) bound = 0.20
 *      ->  feedback "tighten to 0.10" mutates study.constraints (constraints_changed:true)
 *      ->  post-feedback run bound = 0.10, applied_feedback_id = the tightening feedback
 *
 * The driver ASSERTS this before/after contrast and EXITS NON-ZERO if it cannot prove it.
 *
 * Env:
 *   CONTROL_PLANE  (default http://127.0.0.1:8787)
 *   TOKEN          internal bearer (must match the Worker's LABMATE_INTERNAL_TOKEN)
 *   MAX_TRIALS     study trial budget (default 8 — room for post-feedback runs)
 *   DEADLINE_S     overall wait budget in seconds (default 420)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const BASE = (process.env.CONTROL_PLANE || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.TOKEN || "labmate-local-e2e-token-000000000000";
const MAX_TRIALS = Number(process.env.MAX_TRIALS || 8);
const DEADLINE_S = Number(process.env.DEADLINE_S || 420);

const BEFORE_FPR = 0.2; // the guardrail the study is created with
const AFTER_FPR = 0.1; // the tightened guardrail the human feedback enforces

const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const approxEq = (a, b, eps = 1e-6) => typeof a === "number" && Math.abs(a - b) <= eps;

async function jget(path) {
  const r = await fetch(`${BASE}${path}`, { headers: H });
  return r.json();
}
async function jpost(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function brief() {
  try {
    return readFileSync(join(REPO, "examples/sla_tickets/brief.md"), "utf8").slice(0, 1000);
  } catch {
    return "Predict whether a support ticket will breach its SLA, at ticket creation time.";
  }
}

/** Read the FPR bound off a study's constraints (guardrails[].expr | guardrail | string). */
function constraintFprBound(constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  const exprs = [];
  const push = (item) => {
    if (typeof item === "string") exprs.push(item);
    else if (item && typeof item === "object" && typeof item.expr === "string") exprs.push(item.expr);
  };
  const g = constraints.guardrails;
  if (Array.isArray(g)) g.forEach(push);
  else push(g);
  push(constraints.guardrail);
  let bound = null;
  for (const e of exprs) {
    const m = String(e).match(/false[_\s]?positive[_\s]?rate\s*<=?\s*([0-9]*\.?[0-9]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && (bound === null || v < bound)) bound = v;
    }
  }
  return bound;
}

async function main() {
  // 1. create the golden study with the FPR <= 0.20 guardrail (kicks the agent session).
  const create = await jpost("/api/studies", {
    brief: brief(),
    owner: "e2e@local",
    task_type: "binary_classification",
    dataset_id: "sla_tickets",
    target: "breached_sla",
    metric: "recall_at_fpr",
    metric_rationale: "Missed breaches are costlier than false alarms up to 20% FPR.",
    constraints: {
      primary_metric: "recall",
      guardrails: [{ expr: "false_positive_rate <= 0.20" }],
      banned_columns: ["resolved_at", "time_to_resolution", "closed_status", "agent_notes_final"],
    },
    budget: { max_trials: MAX_TRIALS, budget_seconds: 600 },
  });
  const studyId = create.json.id;
  if (!studyId) {
    log("FAILED to create study:", JSON.stringify(create));
    process.exit(1);
  }
  log(`study: ${studyId}  (created with guardrail false_positive_rate <= ${BEFORE_FPR})`);

  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  // 2. Poll until the FIRST completed run appears. That is the pre-feedback baseline whose
  //    enforced bound we capture as the BEFORE value. We do NOT inject early — the point is
  //    a MID-RUN tightening, so we wait until a run has already enforced the 0.20 bound.
  let beforeRun = null; // the earliest completed run (baseline, pre-feedback)
  let constraintsBefore = null;
  while (elapsed() < DEADLINE_S) {
    const d = await jget(`/api/studies/${studyId}`);
    const completed = (d.runs || []).filter((r) => r.status === "completed");
    if (completed.length) {
      // earliest completed run by created_at (runs are returned created_at ASC)
      beforeRun = completed[0];
      constraintsBefore = d.study?.constraints || null;
      break;
    }
    log(`[${elapsed()}s] waiting for first completed run… (runs so far: ${(d.runs || []).length})`);
    await sleep(6000);
  }
  if (!beforeRun) {
    log("FAILED: no completed run appeared before the deadline — cannot capture the BEFORE bound.");
    process.exit(3);
  }
  const beforeBoundMetric = beforeRun.metrics?.max_fpr; // echoed by the shim
  const beforeBoundConstraint = constraintFprBound(constraintsBefore);
  log(
    `\n[${elapsed()}s] BEFORE — baseline run ${beforeRun.id}: ` +
      `metrics.max_fpr=${beforeBoundMetric}  (study constraint FPR bound=${beforeBoundConstraint})`,
  );

  // 3. MID-RUN human feedback that TIGHTENS the guardrail to 0.10. This is the channel that
  //    now mutates study.constraints (mergeStudyConstraints) + stamps constraints_changed.
  const FEEDBACK =
    "Tighten the false-positive-rate guardrail to 0.10 — we cannot tolerate more than 10% false alarms.";
  const fb = await jpost("/api/feedback", {
    study_id: studyId,
    type: "human_feedback",
    scope: "study",
    content: FEEDBACK,
  });
  const feedbackId = fb.json?.id;
  const constraintsChanged = fb.json?.constraints_changed === true;
  log(
    `[${elapsed()}s] recorded human feedback ${feedbackId}: ` +
      `constraints_changed=${constraintsChanged} ` +
      `changed=${JSON.stringify(fb.json?.constraints_change_summary || fb.json?.parsed_constraints || {})}`,
  );

  // ALSO inject the note as a steering message so the agent SEES it (the causal mutation
  // already happened via /api/feedback above). A bare constraint restatement, though,
  // tends to leave the agent idle — it treats the note as guidance and stops. So the
  // steering message is ACTIONABLE: it restates the tightened bound AND directs the agent
  // to keep going — launch the remaining tuned experiments under the new 0.10 bound, then
  // critique, pick the best vs baseline, record the decision, and write the report. This
  // is exactly what a human would type in the cockpit to keep the study moving, and it is
  // what reliably produces POST-feedback runs (the runs that enforce 0.10) — avoiding the
  // race where the agent finishes (or stalls) before any post-feedback run lands.
  const STEER =
    FEEDBACK +
    " Please CONTINUE the study now under this tightened guardrail: launch the remaining " +
    "tuned experiments (at least two more runs) so they enforce false_positive_rate <= 0.10, " +
    "then critique them, pick the best model vs the baseline, record the promote decision, " +
    "and write the final report with provenance.";
  const msg = await jpost(`/api/studies/${studyId}/message`, { text: STEER });
  log(`[${elapsed()}s] steering message injected: status=${msg.json?.status ?? msg.status}`);

  const feedbackCreatedAt = fb.json?.created_at || new Date().toISOString();

  // 4. Continue polling to a graded verdict, watching for a POST-feedback run that enforces
  //    the tightened 0.10 bound and points its applied_feedback_id back at the tightening fb.
  //
  //    The agent works in bursts and sometimes goes idle mid-loop (after a critique, before
  //    the next launch, or before the report). A human in the cockpit would simply re-prompt
  //    it. So when the study has NOT progressed (same runs+critiques+decisions+artifacts) for
  //    a couple of poll cycles and is not yet done, we RE-SEND the actionable steering
  //    directive. This is the same "keep going" nudge a human gives; it makes the proof
  //    self-contained instead of hostage to the agent's burst timing.
  let last = null;
  let lastProgress = "";
  let stalls = 0;
  let nudges = 0;
  while (elapsed() < DEADLINE_S) {
    await sleep(8000);
    const g = await jget(`/api/studies/${studyId}/grade`);
    const d = await jget(`/api/studies/${studyId}`);
    const comp = (d.runs || []).filter((r) => r.status === "completed").length;
    const fails = (g.checks || []).filter((c) => c.required && !c.passed).map((c) => c.id);
    last = { g, d };
    log(
      `[${elapsed()}s] status=${d.study?.status} verdict=${g.verdict} ` +
        `${g.passed_required}/${g.total_required} runs=${(d.runs || []).length}(c=${comp}) ` +
        `crit=${(d.critiques || []).length} dec=${(d.decisions || []).length} ` +
        `fb=${(d.feedback || []).length} art=${(d.artifacts || []).length}` +
        (fails.length ? ` fails=[${fails.join(",")}]` : ""),
    );
    if (g.verdict === "done") break;

    // stall detection (no ledger movement since the last poll)
    const progress = `${(d.runs || []).length}:${(d.critiques || []).length}:${(d.decisions || []).length}:${(d.artifacts || []).length}`;
    if (progress === lastProgress) stalls += 1;
    else stalls = 0;
    lastProgress = progress;
    if (stalls >= 2 && nudges < 6) {
      nudges += 1;
      stalls = 0;
      const nm = await jpost(`/api/studies/${studyId}/message`, { text: STEER });
      log(`[${elapsed()}s] study idle — re-sent steering directive (#${nudges}): ${nm.json?.status ?? nm.status}`);
    }
  }

  // 5. Final ledger + the causal proof.
  const { g, d } = last || {
    g: await jget(`/api/studies/${studyId}/grade`),
    d: await jget(`/api/studies/${studyId}`),
  };
  const runs = d.runs || [];
  const constraintsAfter = d.study?.constraints || null;
  const afterBoundConstraint = constraintFprBound(constraintsAfter);

  // post-feedback runs: created at/after the feedback, attributed to it, enforcing 0.10.
  const postFeedbackRuns = runs.filter(
    (r) => (r.created_at || "") >= feedbackCreatedAt && r.applied_feedback_id === feedbackId,
  );
  const tightenedRuns = postFeedbackRuns.filter((r) => approxEq(r.metrics?.max_fpr, AFTER_FPR));
  const proofRun = tightenedRuns[0] || null;

  const fbCheck = (g.checks || []).find((c) => c.id === "feedback_affected_plan");

  log("\n================ E2E RESULT ================");
  log(`study_id:   ${studyId}`);
  log(`status:     ${d.study?.status}`);
  log(`verdict:    ${g.verdict} (${g.passed_required}/${g.total_required} required checks)`);
  log(
    `ledger:     hypotheses=${(d.hypotheses || []).length} runs=${runs.length} ` +
      `(completed=${runs.filter((r) => r.status === "completed").length}) ` +
      `critiques=${(d.critiques || []).length} decisions=${(d.decisions || []).length} ` +
      `feedback=${(d.feedback || []).length} artifacts=${(d.artifacts || []).length}`,
  );

  log("\n---------------- CAUSAL FEEDBACK PROOF ----------------");
  log(`study constraint FPR bound:  BEFORE=${beforeBoundConstraint}  AFTER=${afterBoundConstraint}`);
  log(`feedback:                    ${feedbackId} (constraints_changed=${constraintsChanged})`);
  if (proofRun) {
    log(
      `BEFORE→AFTER:  baseline run ${beforeRun.id} bound = ${beforeBoundMetric}  →  ` +
        `feedback "tighten to ${AFTER_FPR}" (${feedbackId})  →  ` +
        `post-feedback run ${proofRun.id} bound = ${proofRun.metrics?.max_fpr} ` +
        `(applied_feedback_id=${proofRun.applied_feedback_id})`,
    );
  } else {
    log(
      `BEFORE→AFTER:  baseline run ${beforeRun.id} bound = ${beforeBoundMetric}  →  ` +
        `feedback "tighten to ${AFTER_FPR}" (${feedbackId})  →  ` +
        `NO post-feedback run enforcing ${AFTER_FPR} found`,
    );
    log(
      `   post-feedback runs attributed to feedback: ${postFeedbackRuns.length} ` +
        `(bounds: ${postFeedbackRuns.map((r) => r.metrics?.max_fpr).join(", ") || "none"})`,
    );
  }
  log(
    `feedback_affected_plan:      ${fbCheck ? (fbCheck.passed ? "PASS" : "FAIL") : "(absent)"}` +
      (fbCheck?.detail ? ` — ${fbCheck.detail}` : ""),
  );

  // ---- assertions (the driver exits non-zero if the proof does not hold) ----
  const problems = [];
  if (!constraintsChanged) problems.push("feedback did not report constraints_changed=true");
  if (!approxEq(beforeBoundConstraint, BEFORE_FPR))
    problems.push(`study constraint BEFORE was ${beforeBoundConstraint}, expected ${BEFORE_FPR}`);
  if (!approxEq(afterBoundConstraint, AFTER_FPR))
    problems.push(`study constraint AFTER was ${afterBoundConstraint}, expected ${AFTER_FPR}`);
  if (beforeBoundMetric !== undefined && !approxEq(beforeBoundMetric, BEFORE_FPR))
    problems.push(`baseline run metrics.max_fpr was ${beforeBoundMetric}, expected ${BEFORE_FPR}`);
  if (!proofRun)
    problems.push(
      `no post-feedback run with metrics.max_fpr=${AFTER_FPR} and applied_feedback_id=${feedbackId}`,
    );
  if (!fbCheck || !fbCheck.passed)
    problems.push("rubric check feedback_affected_plan did not pass causally");

  const fails = (g.checks || []).filter((c) => c.required && !c.passed);
  if (fails.length) {
    log("\nfailing required checks:");
    for (const c of fails) log(`  - ${c.id}: ${c.detail}`);
  } else {
    log("\nall required checks PASS ✅");
  }

  if (problems.length) {
    log("\nPROOF ASSERTIONS FAILED:");
    for (const p of problems) log(`  ✗ ${p}`);
    log("===========================================");
    process.exit(4);
  }

  log(
    "\nPROOF ASSERTIONS PASSED ✅ — human feedback causally tightened the enforced FPR bound (0.20 → 0.10).",
  );
  log("===========================================");
  // Done iff the grade is done AND the causal proof holds.
  process.exit(g.verdict === "done" ? 0 : 2);
}

main().catch((e) => {
  console.error("driver error:", e?.message ?? e);
  process.exit(1);
});
