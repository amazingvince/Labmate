/**
 * Self-drive (outer re-stream) tests — NO network, NO live Anthropic.
 *
 * PRODUCTION BUG these lock down: the Managed Agents SSE stream ends (returns) when the
 * agent's turn ends (`end_turn`) WITHOUT delivering any idle event. The old loop streamed
 * exactly once, so a clean stream-end fell straight to the `finally` and the study stalled
 * at "proposed experiments" with 0 runs. The fix wraps the single stream pass in an OUTER
 * loop that, when a pass ends WITHOUT `done`, sends a continuation nudge and RE-STREAMS —
 * self-driving the study to completion with NO external nudger.
 *
 * These assert, with a stub stream that simply ENDS (no terminal event, no idle event):
 *   1. a stream-end that isn't done triggers a nudge and a re-stream (the agent makes
 *      progress across passes and ultimately grades done);
 *   2. an inert agent (zero tool calls per pass) terminates after the no-progress cap with
 *      the distinct `no_progress` reason — and emits EXACTLY ONE terminal frame;
 *   3. the outer loop honors maxToolCalls (stops with `max_tool_calls`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runStudyLoop } from "../src/loop.mjs";

/** A control plane that grades "done" only after >= `doneAfterRuns` runs + a report. */
function fakeControlPlane({ doneAfterRuns = 2 } = {}) {
  const state = { runs: 0, reports: 0, grades: 0 };
  return {
    state,
    async post(path) {
      if (path === "/api/grade") {
        state.grades += 1;
        const verdict = state.runs >= doneAfterRuns && state.reports >= 1 ? "done" : "not_done";
        return { study_id: "s1", verdict };
      }
      return {};
    },
    // The loop GETs study detail only via fetchStudyConstraints — return no constraints
    // so the nudge text carries no contract reminder (keeps the assertions simple).
    async get() {
      return { study: { id: "s1", constraints: null } };
    },
  };
}

const TERMINAL_KINDS = new Set(["study.done", "session.ended", "loop.finished", "loop.error"]);

test("a turn-end stream-close that isn't done triggers a nudge and re-streams to completion", async () => {
  const cp = fakeControlPlane({ doneAfterRuns: 2 });

  // The agent emits ONE tool-use per turn, then the stream just ENDS (no terminal event,
  // no idle event) — exactly the production `end_turn` close. Across re-streams it lands
  // a baseline run, a second run, then a report. The dispatcher (stubbed below) advances
  // the control-plane state so the grade flips to done after the report.
  const passes = [
    [{ type: "custom_tool_use", custom_tool_use_id: "u1", name: "launch_experiment", input: {} }],
    [{ type: "custom_tool_use", custom_tool_use_id: "u2", name: "launch_experiment", input: {} }],
    [{ type: "custom_tool_use", custom_tool_use_id: "u3", name: "write_report", input: {} }],
    // Safety: if the loop over-streams, later passes are empty (no progress) and the
    // no-progress cap would stop it — but it should grade done at the report.
    [],
    [],
    [],
  ];
  let pass = 0;

  const sent = { messages: [] };
  const agent = {
    sent,
    async createSession() {
      return { id: "ses_1" };
    },
    async sendUserMessage(_s, text) {
      sent.messages.push(text);
    },
    async sendToolResult() {},
    async *streamEvents() {
      const script = passes[pass] ?? [];
      pass += 1;
      for (const evt of script) yield evt;
      // Stream ENDS here with no terminal frame — the production turn-end.
    },
  };

  const dispatcher = {
    async dispatch(name) {
      if (name === "launch_experiment") cp.state.runs += 1;
      if (name === "write_report") cp.state.reports += 1;
      return {};
    },
  };

  const emitted = [];
  const result = await runStudyLoop({
    studyId: "s1",
    agent,
    dispatcher,
    controlPlane: cp,
    emit: (e) => emitted.push(e),
    opts: { agentId: "a", environmentId: "e", maxToolCalls: 20, maxSessionSeconds: 0, constraintTracker: { lastSig: "" } },
  });

  assert.equal(result.done, true, "self-drove to a graded-done verdict with no external nudger");
  assert.equal(result.reason, "graded_done");
  assert.ok(cp.state.runs >= 2, "at least two runs landed across re-streams");
  assert.ok(cp.state.reports >= 1, "a report landed");

  // It re-streamed: more than one pass was consumed, and a nudge was sent between passes.
  assert.ok(pass >= 3, `expected the loop to re-stream (>=3 passes), saw ${pass}`);
  const nudges = emitted.filter((e) => e.kind === "nudge");
  assert.ok(nudges.length >= 1, "at least one continuation nudge between passes");
  const nudgeMsgs = sent.messages.filter((m) => /CONTINUE the study/.test(m));
  assert.ok(nudgeMsgs.length >= 1, "the continuation directive was sent to the agent");

  // Exactly ONE terminal frame.
  const terminals = emitted.filter((e) => TERMINAL_KINDS.has(e.kind));
  assert.equal(terminals.length, 1, "exactly one terminal frame");
  assert.equal(terminals[0].kind, "study.done");
});

test("an inert agent terminates after the no-progress cap with reason=no_progress (one terminal)", async () => {
  const cp = fakeControlPlane({ doneAfterRuns: 99 }); // never grades done

  let passes = 0;
  const sent = { messages: [] };
  const agent = {
    sent,
    async createSession() {
      return { id: "ses_1" };
    },
    async sendUserMessage(_s, text) {
      sent.messages.push(text);
    },
    async sendToolResult() {},
    async *streamEvents() {
      passes += 1;
      // Yields NOTHING and ENDS — zero tool calls per pass (the agent is inert).
    },
  };

  const dispatcher = { async dispatch() { return {}; } };
  const emitted = [];

  const result = await runStudyLoop({
    studyId: "s1",
    agent,
    dispatcher,
    controlPlane: cp,
    emit: (e) => emitted.push(e),
    opts: { agentId: "a", environmentId: "e", maxToolCalls: 20, maxSessionSeconds: 0, constraintTracker: { lastSig: "" } },
  });

  assert.equal(result.done, false, "an inert agent never grades done");
  assert.equal(result.reason, "no_progress", "stops with the distinct no_progress reason");
  // 3 inert rounds (NO_PROGRESS_LIMIT) — bounded, cannot spin forever.
  assert.equal(passes, 3, "stopped after exactly NO_PROGRESS_LIMIT (3) inert rounds");

  const terminals = emitted.filter((e) => TERMINAL_KINDS.has(e.kind));
  assert.equal(terminals.length, 1, "exactly one terminal frame");
  assert.equal(terminals[0].kind, "session.ended");
  assert.equal(terminals[0].reason, "no_progress");
});

test("the outer loop honors maxToolCalls and stops with reason=max_tool_calls", async () => {
  const cp = fakeControlPlane({ doneAfterRuns: 99 }); // never grades done

  const sent = { messages: [] };
  const agent = {
    sent,
    async createSession() {
      return { id: "ses_1" };
    },
    async sendUserMessage(_s, text) {
      sent.messages.push(text);
    },
    async sendToolResult() {},
    async *streamEvents() {
      // Each pass makes one tool call, then the stream ends — so progress continues and
      // the no-progress cap never fires; the tool-call budget must be what stops it.
      yield { type: "custom_tool_use", custom_tool_use_id: `u${Math.random()}`, name: "query_runs", input: {} };
    },
  };

  const dispatcher = { async dispatch() { return {}; } };
  const emitted = [];

  const result = await runStudyLoop({
    studyId: "s1",
    agent,
    dispatcher,
    controlPlane: cp,
    emit: (e) => emitted.push(e),
    opts: { agentId: "a", environmentId: "e", maxToolCalls: 3, maxSessionSeconds: 0, constraintTracker: { lastSig: "" } },
  });

  assert.equal(result.done, false);
  assert.equal(result.reason, "max_tool_calls", "stops on the tool-call budget");
  assert.ok(result.toolCalls <= 3, `tool calls capped at 3, saw ${result.toolCalls}`);

  const terminals = emitted.filter((e) => TERMINAL_KINDS.has(e.kind));
  assert.equal(terminals.length, 1, "exactly one terminal frame");
});
