/**
 * Constraint-awareness tests — NO network, NO live Anthropic.
 *
 * Closes the caveat: enforcement is already causal (launches re-read study.constraints),
 * but the LLM's in-context view of the contract goes stale after a human records
 * constraint-bearing feedback. These tests assert that the UPDATED contract (a tightened
 * FPR bound + a newly banned column) reaches the model's context:
 *
 *   1. the pure formatter turns the Worker's constraints shapes into a reminder line
 *      that names the new FPR bound and the banned column;
 *   2. the loop NUDGE re-surfaces the current contract (re-fetched from a control-plane
 *      stub) into the text sent to the model — so even feedback recorded out-of-band via
 *      /api/feedback (which mutated study.constraints) becomes visible on the next turn;
 *   3. it does so without spamming: an unchanged contract is announced once, not twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeConstraints,
  formatContractReminder,
  constraintsSignature,
  fetchStudyConstraints,
} from "../src/constraints.mjs";
import { runStudyLoop } from "../src/loop.mjs";

/* ---------- 1. the pure formatter ---------- */

test("formatContractReminder names the tightened FPR bound and the banned column", () => {
  // The shape GET /api/studies/:id returns after a human tightened FPR to 0.10 and
  // banned `region`: guardrails as a list of {expr}, primary_metric, banned_columns.
  const constraints = {
    primary_metric: "recall",
    guardrails: [{ expr: "false_positive_rate <= 0.1" }],
    banned_columns: ["region"],
  };
  const reminder = formatContractReminder(constraints);
  assert.ok(reminder, "a reminder line should be produced");
  assert.match(reminder, /current enforced contract/i);
  assert.match(reminder, /primary_metric=recall/);
  assert.match(reminder, /false_positive_rate <= 0\.1\b/, "the new FPR bound must appear");
  assert.match(reminder, /banned_columns: \[region\]/, "the banned column must appear");
});

test("summarizeConstraints tolerates string guardrails and percent bounds", () => {
  const s = summarizeConstraints({ guardrail: "false_positive_rate <= 20%", banned_columns: ["zip"] });
  assert.equal(s.maxFpr, 0.2);
  assert.deepEqual(s.bannedColumns, ["zip"]);
});

test("formatContractReminder returns null when there is nothing to surface", () => {
  assert.equal(formatContractReminder(null), null);
  assert.equal(formatContractReminder({}), null);
});

test("constraintsSignature is stable to ordering and changes when the contract changes", () => {
  const a = constraintsSignature({ guardrails: ["false_positive_rate <= 0.2"], banned_columns: ["region", "zip"] });
  const b = constraintsSignature({ banned_columns: ["zip", "region"], guardrails: ["false_positive_rate <= 0.2"] });
  assert.equal(a, b, "order-independent");
  const c = constraintsSignature({ guardrails: ["false_positive_rate <= 0.1"], banned_columns: ["region", "zip"] });
  assert.notEqual(a, c, "a tightened bound changes the signature");
});

test("fetchStudyConstraints reads study.constraints and never throws", async () => {
  const cp = { get: async () => ({ study: { constraints: { primary_metric: "recall" } } }) };
  assert.deepEqual(await fetchStudyConstraints(cp, "s1"), { primary_metric: "recall" });
  // A bare Study (no .study wrapper) is tolerated.
  const bare = { get: async () => ({ constraints: { banned_columns: ["x"] } }) };
  assert.deepEqual(await fetchStudyConstraints(bare, "s1"), { banned_columns: ["x"] });
  // An error response and a throwing client both degrade to null (never crash).
  assert.equal(await fetchStudyConstraints({ get: async () => ({ error: "nope" }) }, "s1"), null);
  assert.equal(await fetchStudyConstraints({ get: async () => { throw new Error("boom"); } }, "s1"), null);
});

/* ---------- 2. the loop nudge re-surfaces the updated contract ---------- */

/**
 * A control plane stub whose study constraints START loose (FPR 0.20, no bans) and, after
 * the human records feedback out-of-band, return the TIGHTENED contract (FPR 0.10 + a
 * banned `region`). The loop never reaches "done", so it nudges — and the nudge must carry
 * the updated bound + banned column.
 */
function tighteningControlPlane() {
  const state = { tightened: false, gradeCalls: 0 };
  return {
    state,
    // The loop only GETs the study detail (via fetchStudyConstraints).
    async get(path) {
      assert.match(path, /^\/api\/studies\//);
      const constraints = state.tightened
        ? { primary_metric: "recall", guardrails: [{ expr: "false_positive_rate <= 0.1" }], banned_columns: ["region"] }
        : { primary_metric: "recall", guardrails: [{ expr: "false_positive_rate <= 0.2" }], banned_columns: [] };
      return { study: { id: "s1", constraints } };
    },
    async post(path) {
      if (path === "/api/grade") {
        state.gradeCalls += 1;
        return { study_id: "s1", verdict: "not_done" };
      }
      return {};
    },
  };
}

/** An agent stub that records every user message; its stream goes idle (end_turn) twice
 *  then completes, so the loop nudges on each idle. */
function nudgingAgent() {
  const sent = { messages: [] };
  return {
    sent,
    async createSession() {
      return { id: "ses_test" };
    },
    async sendUserMessage(_sessionId, text) {
      sent.messages.push(text);
    },
    async sendToolResult() {},
    async *streamEvents() {
      // First idle: nudge #1 (contract still loose).
      yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
      // The human tightens the contract out-of-band between turns; the next nudge must
      // pick it up. The test flips the flag via the closure below before yielding again.
      yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
      yield { type: "session.completed" };
    },
  };
}

test("loop nudge re-surfaces the UPDATED contract (new FPR bound + banned column) to the model", async () => {
  const cp = tighteningControlPlane();
  const agent = nudgingAgent();

  // Flip the contract to tightened AFTER the first nudge is sent, simulating an
  // out-of-band /api/feedback that mutated study.constraints mid-run.
  const originalSend = agent.sendUserMessage.bind(agent);
  let nudges = 0;
  agent.sendUserMessage = async (sessionId, text) => {
    await originalSend(sessionId, text);
    if (/Review the latest runs/.test(text)) {
      nudges += 1;
      if (nudges === 1) cp.state.tightened = true; // human tightens before the 2nd nudge
    }
  };

  const constraintTracker = { lastSig: "" };
  const result = await runStudyLoop({
    studyId: "s1",
    agent,
    dispatcher: { dispatch: async () => ({}) },
    controlPlane: cp,
    emit: () => {},
    opts: { agentId: "a", environmentId: "e", maxToolCalls: 20, maxSessionSeconds: 0, constraintTracker },
  });

  assert.equal(result.done, false, "study never grades done in this stub");

  const nudgeMsgs = agent.sent.messages.filter((m) => /Review the latest runs/.test(m));
  assert.ok(nudgeMsgs.length >= 2, "expected at least two nudges");

  // First nudge: loose contract surfaced (FPR 0.2, no bans).
  assert.match(nudgeMsgs[0], /false_positive_rate <= 0\.2\b/);
  assert.doesNotMatch(nudgeMsgs[0], /banned_columns: \[region\]/);

  // Second nudge (after the out-of-band tightening): the UPDATED bound + banned column
  // reach the model. THIS is the awareness fix — without it the LLM only learns of the
  // change by hitting a launch rejection.
  assert.match(nudgeMsgs[1], /false_positive_rate <= 0\.1\b/, "tightened FPR bound surfaced to the model");
  assert.match(nudgeMsgs[1], /banned_columns: \[region\]/, "newly banned column surfaced to the model");

  // The shared tracker now reflects the tightened contract.
  assert.equal(
    constraintTracker.lastSig,
    constraintsSignature({ primary_metric: "recall", guardrails: [{ expr: "false_positive_rate <= 0.1" }], banned_columns: ["region"] }),
  );
});

test("loop nudge does NOT re-announce an unchanged contract twice", async () => {
  const cp = tighteningControlPlane(); // stays loose — never tightened
  const agent = nudgingAgent();
  const constraintTracker = { lastSig: "" };

  await runStudyLoop({
    studyId: "s1",
    agent,
    dispatcher: { dispatch: async () => ({}) },
    controlPlane: cp,
    emit: () => {},
    opts: { agentId: "a", environmentId: "e", maxToolCalls: 20, maxSessionSeconds: 0, constraintTracker },
  });

  const withContract = agent.sent.messages.filter((m) => /current enforced contract/.test(m));
  assert.equal(withContract.length, 1, "an unchanged contract is surfaced once, not on every nudge");
});

/* ---------- 3. the server's /message inject composition (helper-level) ---------- */

test("the /message inject composes the human note with the current contract reminder", () => {
  // Mirrors server.mjs's composition: `[human guidance] <note>` + the reminder line.
  // (The handler itself is exercised end-to-end by the runtime smoke test; here we lock
  // the contract-awareness composition the handler performs.)
  const note = "Recall matters more, but keep false positives under 10% and stop using region.";
  const constraints = {
    primary_metric: "recall",
    guardrails: [{ expr: "false_positive_rate <= 0.1" }],
    banned_columns: ["region"],
  };
  let injected = `[human guidance] ${note}`;
  const reminder = formatContractReminder(constraints);
  if (reminder) injected += `\n${reminder}`;

  assert.match(injected, /^\[human guidance\] Recall matters more/);
  assert.match(injected, /false_positive_rate <= 0\.1\b/);
  assert.match(injected, /banned_columns: \[region\]/);
});
