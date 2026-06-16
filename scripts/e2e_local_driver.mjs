/**
 * E2E local driver — creates the golden sla_tickets study against the LOCAL control
 * plane, injects an EARLY human-feedback constraint (so a launched run records
 * applied_feedback_id and the rubric's feedback_affected_plan passes), then polls the
 * rubric grade until the study is done (or a deadline). Prints the final ledger counts
 * and grade verdict.
 *
 * This is the agent-driven path: creating the study kicks the agent-runtime (Managed
 * Agents session). We do NOT POST manifests — the LLM agent profiles, proposes,
 * launches, critiques, decides, reports. We only supply ONE business-feedback message,
 * exactly as a human would in the cockpit.
 *
 * Env:
 *   CONTROL_PLANE  (default http://127.0.0.1:8787)
 *   TOKEN          internal bearer (must match the Worker's LABMATE_INTERNAL_TOKEN)
 *   MAX_TRIALS     study trial budget (default 8 — room for a feedback-applied run)
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

const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

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

async function main() {
  // 1. create the golden study (kicks the agent-runtime session)
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
  log(`study: ${studyId}`);

  // 2. inject EARLY human feedback — as soon as the runtime session is ready, BEFORE the
  // agent spends its trial budget. The Worker parses it into {primary_metric, guardrail}
  // and resolveAppliedFeedbackId then auto-attaches its id to every subsequently launched
  // run (rubric feedback_affected_plan). Retry until the session accepts the message.
  const FEEDBACK =
    "Early guidance: recall on breached_sla matters more than precision, but keep the " +
    "false positive rate at or below 20%. Apply this metric and guardrail to your experiments.";
  let injected = false;
  for (let i = 0; i < 60; i += 1) {
    const r = await jpost(`/api/studies/${studyId}/message`, { text: FEEDBACK });
    if (r.json?.status === "queued") {
      injected = true;
      const d = await jget(`/api/studies/${studyId}`);
      log(`injected early feedback at ~${i}s (runs so far: ${(d.runs || []).length})`);
      break;
    }
    await sleep(1000);
  }
  if (!injected) log("WARN: could not inject early feedback (session never ready) — continuing");

  // 3. poll the rubric grade until done or deadline.
  const t0 = Date.now();
  let last = null;
  while ((Date.now() - t0) / 1000 < DEADLINE_S) {
    await sleep(8000);
    const g = await jget(`/api/studies/${studyId}/grade`);
    const d = await jget(`/api/studies/${studyId}`);
    const comp = (d.runs || []).filter((r) => r.status === "completed").length;
    const fails = (g.checks || []).filter((c) => c.required && !c.passed).map((c) => c.id);
    last = { g, d };
    log(
      `[${Math.round((Date.now() - t0) / 1000)}s] status=${d.study?.status} ` +
        `verdict=${g.verdict} ${g.passed_required}/${g.total_required} ` +
        `runs=${(d.runs || []).length}(c=${comp}) crit=${(d.critiques || []).length} ` +
        `dec=${(d.decisions || []).length} fb=${(d.feedback || []).length} art=${(d.artifacts || []).length}` +
        (fails.length ? ` fails=[${fails.join(",")}]` : ""),
    );
    if (g.verdict === "done") break;
  }

  // 4. final report
  const { g, d } = last || { g: await jget(`/api/studies/${studyId}/grade`), d: await jget(`/api/studies/${studyId}`) };
  const promoted = (d.decisions || []).find((x) => x.action === "promote");
  log("\n================ E2E RESULT ================");
  log(`study_id:   ${studyId}`);
  log(`status:     ${d.study?.status}`);
  log(`verdict:    ${g.verdict} (${g.passed_required}/${g.total_required} required checks)`);
  log(
    `ledger:     hypotheses=${(d.hypotheses || []).length} runs=${(d.runs || []).length} ` +
      `(completed=${(d.runs || []).filter((r) => r.status === "completed").length}) ` +
      `critiques=${(d.critiques || []).length} decisions=${(d.decisions || []).length} ` +
      `feedback=${(d.feedback || []).length} artifacts=${(d.artifacts || []).length}`,
  );
  log(`promoted:   ${promoted ? promoted.promoted_run_id : "(none)"}`);
  const fails = (g.checks || []).filter((c) => c.required && !c.passed);
  if (fails.length) {
    log("failing required checks:");
    for (const c of fails) log(`  - ${c.id}: ${c.detail}`);
  } else {
    log("all required checks PASS ✅");
  }
  log("===========================================");
  process.exit(g.verdict === "done" ? 0 : 2);
}

main().catch((e) => {
  console.error("driver error:", e?.message ?? e);
  process.exit(1);
});
