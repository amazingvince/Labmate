/**
 * End-to-end smoke test for the agent runtime — NO network.
 *
 * It stubs the Managed Agents stream with a scripted sequence of tool-use events
 * (the agent "deciding" to profile, propose, launch a leaky run, get rejected,
 * rerun corrected, then report), and stubs the control plane to record state. It
 * asserts the loop:
 *   - dispatches every tool the agent emits,
 *   - relays the 422 banned-column rejection so a corrected rerun happens,
 *   - reaches a report and a done verdict.
 *
 * This is the runtime's definition of done. Run: node --test tests/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatcher } from "../src/dispatch.mjs";
import { runStudyLoop, extractToolUse } from "../src/loop.mjs";
import { LABMATE_TOOL_NAMES } from "../src/tools.mjs";

/* ---------- a fake control plane that records the ledger ---------- */
function fakeControlPlane() {
  const state = {
    runs: [],
    critiques: [],
    reports: [],
    approvals: [],
    hypotheses: [],
    graded: false,
  };
  const BANNED = ["resolved_at", "time_to_resolution", "closed_status", "agent_notes_final"];

  return {
    state,
    async post(path, body) {
      switch (path) {
        case "/api/profile":
          return { id: "dsv_1", study_id: body.study_id, row_count: 12000, columns: [] };
        case "/api/experiments/propose":
          state.hypotheses.push(...(body.hypotheses ?? []));
          return { hypotheses: (body.hypotheses ?? []).map((_, i) => ({ id: `hyp_${i}` })) };
        case "/api/approvals/request":
          state.approvals.push(body);
          return { approval_id: `appr_${state.approvals.length}`, status: "pending" };
        case "/api/experiments/launch": {
          const feats = body?.manifest?.features ?? [];
          const tuneOn = body?.manifest?.search?.tune_on;
          // Enforce the same guards the real runner does.
          if (feats.some((f) => BANNED.includes(f))) {
            return { error: "banned_column_in_features", detail: feats.filter((f) => BANNED.includes(f)).join(","), http_status: 422 };
          }
          if (tuneOn === "test") {
            return { error: "tune_on_test_forbidden", http_status: 422 };
          }
          const run = {
            id: `run_${state.runs.length + 1}`,
            status: "completed",
            metrics: { recall_at_fpr: 0.62 + state.runs.length * 0.05 },
            tags: body?.manifest?.tags ?? [],
            hypothesis_id: body?.manifest?.hypothesis_id,
          };
          state.runs.push(run);
          return run;
        }
        case "/api/runs/query":
          return { runs: state.runs };
        case "/api/critiques":
          state.critiques.push(body);
          return { id: `crit_${state.critiques.length}` };
        case "/api/reports":
          state.reports.push(body);
          return { study_id: body.study_id, uri: "r2://reports/demo.html", compares_best_to_baseline: true };
        case "/api/grade":
          // "Done" once we have a baseline, a corrected run, a critique, and a report.
          state.graded = state.runs.length >= 2 && state.critiques.length >= 1 && state.reports.length >= 1;
          return { study_id: body.study_id, verdict: state.graded ? "done" : "not_done" };
        default:
          return { error: "unknown_path", path };
      }
    },
    get: async () => ({}),
  };
}

/* ---------- a fake Managed Agents adapter with a scripted stream ---------- */
function fakeAgent(script) {
  const sent = { messages: [], toolResults: [] };
  return {
    sent,
    async createSession() {
      return { id: "ses_test" };
    },
    async sendUserMessage(_sessionId, text) {
      sent.messages.push(text);
    },
    async sendToolResult(_sessionId, id, content, isError) {
      sent.toolResults.push({ id, content, isError });
    },
    async *streamEvents() {
      for (const evt of script) yield evt;
      yield { type: "session.completed" };
    },
  };
}

/** Helper to build a custom tool-use event. */
const toolUse = (id, name, input) => ({ type: "custom_tool_use", custom_tool_use_id: id, name, input });

test("extractToolUse handles direct and content-block shapes", () => {
  assert.equal(extractToolUse(toolUse("t1", "query_runs", { study_id: "s" }))?.name, "query_runs");
  const blockForm = { type: "assistant.message", content: [{ type: "tool_use", id: "t2", name: "write_report", input: {} }] };
  assert.equal(extractToolUse(blockForm)?.name, "write_report");
});

test("dispatcher covers every declared tool", () => {
  const dispatcher = makeDispatcher({ controlPlane: fakeControlPlane(), modal: {} });
  for (const name of LABMATE_TOOL_NAMES) {
    assert.ok(dispatcher.has(name), `dispatcher missing handler for ${name}`);
  }
});

test("launch_experiment without approval is gated (402)", async () => {
  const cp = fakeControlPlane();
  const dispatcher = makeDispatcher({ controlPlane: cp, modal: {} });
  const res = await dispatcher.dispatch("launch_experiment", { manifest: { features: ["priority"] } });
  assert.equal(res.http_status, 402);
  assert.equal(cp.state.runs.length, 0);
});

test("full loop: profile → propose → leaky launch rejected → corrected rerun → report → done", async () => {
  const cp = fakeControlPlane();
  const dispatcher = makeDispatcher({ controlPlane: cp, modal: {} });

  // The scripted "agent": tries a leaky baseline, gets 422, reruns clean, then a
  // second experiment, critiques it, and writes the report.
  const script = [
    toolUse("u1", "profile_dataset", { study_id: "s1" }),
    toolUse("u2", "propose_experiments", {
      study_id: "s1",
      hypotheses: [{ statement: "baseline", model_family: "logistic_regression", features: ["priority"] }],
    }),
    toolUse("u3", "request_approval", { study_id: "s1", reason: "run baseline" }),
    // leaky attempt — includes a banned column; dispatcher must relay 422
    toolUse("u4", "launch_experiment", {
      approval_id: "appr_1",
      manifest: { study_id: "s1", hypothesis_id: "hyp_0", features: ["priority", "resolved_at"], tags: ["baseline"] },
    }),
    // corrected rerun — banned column removed (this is run_1)
    toolUse("u5", "launch_experiment", {
      approval_id: "appr_1",
      manifest: { study_id: "s1", hypothesis_id: "hyp_0", features: ["priority"], tags: ["baseline"] },
    }),
    toolUse("u6", "record_critique", {
      study_id: "s1",
      target_run_id: "run_1",
      kind: "leakage",
      finding: "resolved_at is post-outcome",
      led_to_decision: "rerun",
    }),
    // a second, non-baseline experiment (this is run_2)
    toolUse("u7", "launch_experiment", {
      approval_id: "appr_1",
      manifest: { study_id: "s1", hypothesis_id: "hyp_1", model: { family: "hist_gradient_boosting" }, features: ["priority", "queue_depth_at_creation"], tags: [] },
    }),
    toolUse("u8", "write_report", { study_id: "s1" }),
  ];

  const agent = fakeAgent(script);
  const emitted = [];
  const result = await runStudyLoop({
    studyId: "s1",
    agent,
    dispatcher,
    controlPlane: cp,
    emit: (e) => emitted.push(e),
    opts: { agentId: "agent_x", environmentId: "env_x", maxToolCalls: 20 },
  });

  // The leaky run was rejected (422) and never recorded; only clean runs landed.
  assert.equal(cp.state.runs.length, 2, "exactly the two non-leaky runs recorded");
  // A leakage critique was recorded.
  assert.equal(cp.state.critiques.length, 1);
  assert.equal(cp.state.critiques[0].kind, "leakage");
  // A report exists and the study graded done.
  assert.equal(cp.state.reports.length, 1);
  assert.equal(result.done, true, "loop should reach a done verdict");

  // The runtime relayed a 422 tool result back to the agent (the self-correction trigger).
  const got422 = agent.sent.toolResults.some((r) => r.isError && /422/.test(r.content));
  assert.ok(got422, "a 422 rejection should have been returned to the agent");

  // We surfaced activity to the cockpit.
  assert.ok(emitted.some((e) => e.kind === "tool.use"));
  assert.ok(emitted.some((e) => e.kind === "study.done"));
});
