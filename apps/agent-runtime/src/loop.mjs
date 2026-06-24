/**
 * The session loop — the heart of the runtime.
 *
 * Lifecycle for one study:
 *   1. create a session (agent + environment)
 *   2. send the brief + data contract + rubric as a user.message
 *   3. stream events:
 *        - assistant text / thinking → emit to subscribers (cockpit activity)
 *        - custom tool-use           → dispatch → send user.custom_tool_result
 *        - awaiting input / idle      → check done; if not & budget remains, nudge
 *   4. finish: mark study complete, surface report+model
 *
 * The loop is transport-agnostic about *how* events arrive: it consumes an async
 * iterable of events (real SDK stream, or a stubbed array in tests) and calls the
 * injected `agent` adapter to send messages/results back. This is what lets the
 * smoke test drive the whole thing with zero network.
 */

import { fetchStudyConstraints, formatContractReminder, constraintsSignature } from "./constraints.mjs";

/**
 * @param {object} o
 * @param {string} o.studyId
 * @param {object} o.agent      adapter: { createSession, sendUserMessage, sendToolResult, streamEvents }
 * @param {object} o.dispatcher from makeDispatcher()
 * @param {object} o.controlPlane control-plane client (for the done check)
 * @param {(evt: object) => void} [o.emit] called for every event worth showing the human
 * @param {object} [o.opts]      { agentId, environmentId, maxToolCalls, outcomesEnabled, brief, constraintTracker }
 */
export async function runStudyLoop({ studyId, agent, dispatcher, controlPlane, emit = () => {}, opts = {} }) {
  const {
    agentId,
    environmentId,
    maxToolCalls = 60,
    maxSessionSeconds = 1800,
    outcomesEnabled = false,
    brief, // { text } — the message that kicks off the work
    // Shared with server.mjs's /message handler: { lastSig } — the signature of the
    // last contract surfaced to the LLM. The nudge re-announces the CURRENT contract
    // only when it CHANGED since then, so out-of-band /api/feedback (which mutated
    // study.constraints) becomes visible without spamming an unchanged contract.
    constraintTracker = { lastSig: "" },
  } = opts;

  // Session wall-clock budget (enforced below) — captured before any network call so
  // a slow createSession counts against it too.
  const startedAt = Date.now();
  const deadlineMs = maxSessionSeconds > 0 ? startedAt + maxSessionSeconds * 1000 : Infinity;
  const overDeadline = () => Date.now() > deadlineMs;

  // Terminal-frame bookkeeping. The loop guarantees EXACTLY ONE terminal frame
  // (kind in TERMINAL_KINDS) is emitted before it returns, so the cockpit's
  // EventSource stops reconnecting and the server can close subscribers + GC.
  let terminalEmitted = false;
  let done = false;
  let toolCalls = 0;
  /** @param {string} kind @param {object} [extra] */
  function emitTerminal(kind, extra = {}) {
    if (terminalEmitted) return;
    terminalEmitted = true;
    emit({ kind, study_id: studyId, ...extra });
  }

  /**
   * Re-fetch the study's CURRENT constraints and, if they CHANGED since we last
   * surfaced them (tracked across server.mjs's /message inject and this nudge), return
   * one compact reminder line to append to the nudge — so the LLM re-plans toward the
   * new bound even when the human's feedback arrived out-of-band via /api/feedback.
   * Best-effort and cheap (one GET, guarded); returns "" when nothing changed or the
   * fetch fails, so the nudge text is unchanged in the common case.
   * @returns {Promise<string>} the reminder line (with leading newline) or ""
   */
  async function contractReminderIfChanged() {
    try {
      const constraints = await fetchStudyConstraints(controlPlane, studyId);
      const reminder = formatContractReminder(constraints);
      if (!reminder) return "";
      const sig = constraintsSignature(constraints);
      if (sig && sig === constraintTracker.lastSig) return ""; // already surfaced — don't spam
      constraintTracker.lastSig = sig;
      emit({ kind: "constraints.refreshed", study_id: studyId, reminder });
      return `\n${reminder}`;
    } catch {
      return ""; // never let awareness break the loop
    }
  }

  let sessionId;
  try {
    const session = await agent.createSession({
      agentId,
      environmentId,
      title: `Labmate study ${studyId}`,
      metadata: { study_id: studyId },
    });
    sessionId = session.id;
  } catch (err) {
    // createSession failed → there is no session to stream. Emit a terminal frame so
    // subscribers aren't stranded waiting on a stream that will never open.
    emitTerminal("session.ended", { reason: "create_session_failed", error: String(err?.message ?? err) });
    return { sessionId: null, done: false, toolCalls: 0, terminated: "create_session_failed" };
  }
  emit({ kind: "session.created", study_id: studyId, session_id: sessionId });

  // Kick off the work.
  const kickoff =
    brief?.text ??
    `You are running Labmate study ${studyId}. Profile the dataset, review it for ` +
      `leakage, propose experiments (asking approval before compute), launch them in ` +
      `the Modal sandbox, critique each result, and iterate until the rubric is met. ` +
      `Start by calling profile_dataset for this study.`;
  try {
    await agent.sendUserMessage(sessionId, kickoff);
  } catch (err) {
    emitTerminal("session.ended", { reason: "kickoff_send_failed", error: String(err?.message ?? err) });
    return { sessionId, done: false, toolCalls: 0, terminated: "kickoff_send_failed" };
  }
  emit({ kind: "user.message", study_id: studyId, text: kickoff });
  // Buffer custom tool-use events by id so the requires_action sweep (which keys
  // off stop_reason.event_ids) can find one delivered only via history replay.
  const toolUseBuffer = new Map();
  const dispatchedIds = new Set();

  /**
   * Execute one custom tool-use, return its result to the session, and report
   * whether the study is now done. Deduped by id so the direct path and the
   * requires_action sweep never double-execute the same call.
   * @returns {Promise<boolean>} true if the study graded done after a write_report
   */
  async function dispatchToolUse(tu) {
    if (!tu || !tu.id || dispatchedIds.has(tu.id)) return false;
    dispatchedIds.add(tu.id);

    // Budget check BEFORE the increment/emit: a budget-exhausted call must not look
    // like a real tool.use in the cockpit. Emit a distinct tool.budget_exhausted and
    // return the budget error to the agent without dispatching.
    if (toolCalls + 1 > maxToolCalls) {
      emit({ kind: "tool.budget_exhausted", study_id: studyId, name: tu.name, used: toolCalls, max: maxToolCalls });
      await agent.sendToolResult(
        sessionId,
        tu.id,
        JSON.stringify({
          error: "budget_exhausted",
          detail: "Tool-call budget reached. Write the report with what you have and stop.",
        }),
        true,
      );
      return false;
    }

    toolCalls += 1;
    emit({ kind: "tool.use", study_id: studyId, name: tu.name, input: tu.input });

    const result = await dispatcher.dispatch(tu.name, tu.input ?? {});
    emit({ kind: "tool.result", study_id: studyId, name: tu.name, result });
    await agent.sendToolResult(sessionId, tu.id, JSON.stringify(result), Boolean(result?.error));

    // Only grade after a report that actually SUCCEEDED. A failed write_report (error
    // result) must not trigger a done check against a study with no real report.
    if (tu.name === "write_report" && !result?.error) {
      return await isDoneGated({ studyId, controlPlane, outcomesEnabled, session: agent, sessionId, emit });
    }
    return false;
  }

  // `reason` records WHY the loop ended, surfaced on the terminal frame.
  let reason = "stream_ended";

  /**
   * Push the agent to take the next step. Re-surfaces the CURRENT enforced contract if
   * a human changed it since we last told the model, then sends the actionable
   * "keep going" directive and emits a nudge frame. Shared by the mid-stream idle path
   * and the OUTER re-stream below — so production (where the turn-end simply CLOSES the
   * stream and no idle event ever arrives) is self-driven to completion with NO external
   * nudger. Throws only if the underlying send fails (the caller treats that as terminal).
   */
  async function sendContinuationNudge() {
    // Surface the CURRENT enforced contract if a human changed it since we last told the
    // model (incl. out-of-band /api/feedback that mutated study.constraints), so the next
    // step is planned toward the new bound — not discovered via a 422.
    const contractLine = await contractReminderIfChanged();
    await agent.sendUserMessage(
      sessionId,
      "Review the latest runs with query_runs, then CONTINUE the study to completion. " +
        "If you have not yet: run the leakage review, launch the baseline, then the tuned " +
        "experiments — request approval before each launch (approvals auto-grant within " +
        "budget). Critique each result, record the promote/reject decision, then call " +
        "write_report. If an experiment beat the baseline and survives a leakage/" +
        "calibration check, promote it and write_report. Do not stop until the study is " +
        "graded done; keep going step by step." +
        contractLine,
    );
    emit({ kind: "nudge", study_id: studyId });
  }

  /**
   * One full pass over `agent.streamEvents(sessionId)`. Returns WHY the pass ended:
   *   "done"         — graded done (sets the outer `done` flag too); stop.
   *   "deadline"     — session wall-clock budget reached mid-stream; stop.
   *   "session_error"/"stream_failed" — terminal; the terminal frame is ALREADY emitted
   *                    here, so the outer loop must NOT emit another; stop.
   *   "session.*"/"completed" — an explicit terminal session state arrived; stop.
   *   "stream_ended" — the stream closed cleanly with no `done` (the production turn-end
   *                    `end_turn` close). The OUTER loop re-streams after a nudge.
   *
   * All in-stream handling (narration, tool dispatch, the requires_action sweep, the
   * mid-stream idle nudge, errors, terminal states) is preserved exactly as before.
   */
  async function streamOnce() {
    try {
      for await (const event of agent.streamEvents(sessionId)) {
        // Session wall-clock budget: enforced on every event (and again in the outer
        // loop). A breach nudges the agent to stop and returns "deadline" — it never
        // hangs to the SSE idle timeout.
        if (overDeadline()) {
          try {
            await agent.sendUserMessage(
              sessionId,
              "Session time budget reached. Stop now; do not start new experiments.",
            );
          } catch {
            /* best-effort note; we are terminating regardless */
          }
          return "deadline";
        }

        const type = event.type ?? event.event ?? "";

        // 1. Surface assistant narration to the cockpit. `agent.*` are the live
        // managed-agents shapes; `assistant.*`/`message` tolerate older builds/tests.
        if (
          type === "agent.message" ||
          type === "agent.thinking" ||
          type === "assistant.message" ||
          type === "assistant.thinking" ||
          type === "message"
        ) {
          emit({ kind: "agent.activity", study_id: studyId, event });
          continue;
        }

        // 2. Custom tool-use → buffer it (by event id and tool-use id) then dispatch.
        const toolUse = extractToolUse(event);
        if (toolUse) {
          if (event.id) toolUseBuffer.set(event.id, toolUse);
          if (toolUse.id) toolUseBuffer.set(toolUse.id, toolUse);
          if (await dispatchToolUse(toolUse)) {
            done = true;
            return "done";
          }
          continue;
        }

        // 3. The agent went idle. On the live API `session.status_idle` carries a
        // `stop_reason`. `requires_action` means it is blocked on tool results we owe
        // it: the blocking event ids are in stop_reason.event_ids — dispatch any we
        // buffered but have not answered (a safety net over the direct path for an
        // event seen only via history replay), then keep waiting (do NOT nudge).
        // Any other stop reason (`end_turn`, `retries_exhausted`) is a real stopping
        // point where we check done and otherwise nudge the next step.
        if (
          type === "session.status_idle" ||
          type === "session.awaiting_input" ||
          type === "session.idle" ||
          type === "awaiting_input"
        ) {
          const stopReason = event.stop_reason ?? event.stopReason;
          if (stopReason?.type === "requires_action") {
            for (const id of stopReason.event_ids ?? []) {
              const tu = toolUseBuffer.get(id);
              if (tu && (await dispatchToolUse(tu))) {
                done = true;
                break;
              }
            }
            if (done) return "done";
            continue;
          }
          done = await isDoneGated({ studyId, controlPlane, outcomesEnabled, session: agent, sessionId, emit });
          if (done) return "done";
          await sendContinuationNudge();
          continue;
        }

        // 3b. Session errors are conveyed as session.error (carrying error.message and a
        // retry_status). If the orchestrator is retrying, keep streaming; otherwise it's
        // a clean terminal failure — surface it and stop (don't hang to the SSE timeout).
        if (type === "session.error") {
          const err = event.error ?? {};
          const retrying = err.retry_status === "retrying" || event.retry_status === "retrying";
          if (retrying) {
            // Non-terminal: surface progress but keep streaming.
            emit({ kind: "loop.error", study_id: studyId, error: err.message ?? "session.error", retry_status: "retrying" });
            continue;
          }
          emitTerminal("loop.error", { error: err.message ?? "session.error", terminal: true });
          return "session_error";
        }

        // 4. Terminal session states.
        if (
          type === "session.status_terminated" ||
          type === "session.completed" ||
          type === "session.failed" ||
          type === "completed"
        ) {
          return type;
        }
      }
    } catch (err) {
      // The stream tail threw (reconnect budget exhausted, or an unexpected adapter
      // error). This is terminal: emit a distinct terminal frame so subscribers close
      // instead of waiting on a stream that will never resume.
      emitTerminal("loop.error", { error: String(err?.message ?? err), terminal: true, code: err?.code });
      return "stream_failed";
    }
    // The stream closed cleanly with no `done` decision. On the live API this is the
    // `end_turn`/`max_tokens` turn-end that simply ENDS the SSE stream — there is no idle
    // event to nudge on. The OUTER loop re-streams after a continuation nudge.
    return "stream_ended";
  }

  // ---- OUTER SELF-DRIVE LOOP ---------------------------------------------------------
  // A single stream pass ends when the agent's turn ends (the `end_turn` close ENDS the
  // SSE stream). That is NOT "done" — the runtime must push the agent to the next step
  // itself, with no external nudger. So we RE-STREAM while the study is not done and
  // budget remains, sending a continuation nudge between passes. A no-progress cap
  // (N consecutive rounds with ZERO new tool calls) guarantees we can't spin forever if
  // the agent goes inert. maxToolCalls / maxSessionSeconds are honored here AND in-stream.
  const NO_PROGRESS_LIMIT = 3;
  let noProgressRounds = 0;
  try {
    for (;;) {
      // Budget gates BEFORE a stream pass (re-checked inside the stream too).
      if (overDeadline()) {
        reason = "max_session_seconds";
        break;
      }
      if (toolCalls >= maxToolCalls) {
        reason = "max_tool_calls";
        break;
      }

      const toolCallsBefore = toolCalls;
      const status = await streamOnce();

      if (status === "done") {
        reason = "graded_done";
        break;
      }
      if (status === "deadline") {
        reason = "max_session_seconds";
        break;
      }
      // streamOnce already emitted the terminal frame for these — do NOT emit another.
      if (status === "session_error") {
        reason = "session_error";
        break;
      }
      if (status === "stream_failed") {
        reason = "stream_failed";
        break;
      }
      if (
        status === "session.status_terminated" ||
        status === "session.completed" ||
        status === "session.failed" ||
        status === "completed"
      ) {
        reason = status;
        break;
      }

      // status === "stream_ended": a clean turn-end with no done verdict — the production
      // stall point. Re-check the grade once (a write_report may have landed in this pass
      // without our gate firing, e.g. via history replay) before re-streaming.
      done = await isDoneGated({ studyId, controlPlane, outcomesEnabled, session: agent, sessionId, emit });
      if (done) {
        reason = "graded_done";
        break;
      }

      // No-progress cap: a full round with ZERO new tool calls means the agent is inert.
      // Count consecutive inert rounds and bail with a distinct terminal reason so a stuck
      // agent can't burn the whole wall-clock budget re-streaming nothing.
      if (toolCalls === toolCallsBefore) {
        noProgressRounds += 1;
        if (noProgressRounds >= NO_PROGRESS_LIMIT) {
          reason = "no_progress";
          break;
        }
      } else {
        noProgressRounds = 0;
      }

      // Re-check budget before nudging + re-streaming (this round may have exhausted it).
      if (overDeadline()) {
        reason = "max_session_seconds";
        break;
      }
      if (toolCalls >= maxToolCalls) {
        reason = "max_tool_calls";
        break;
      }

      // Push the agent to continue, then loop back to re-stream.
      try {
        await sendContinuationNudge();
      } catch (err) {
        // Can't re-prompt the agent → no way to make progress; stop cleanly with a
        // distinct terminal frame (the finally guard below then no-ops).
        reason = "nudge_send_failed";
        emitTerminal("session.ended", { reason: "nudge_send_failed", error: String(err?.message ?? err) });
        break;
      }
    }
  } finally {
    // GUARANTEE exactly one terminal frame. If we broke for done/timeout/clean-end and
    // haven't already emitted one (session.error/stream_failed paths do), emit it now.
    if (!terminalEmitted) {
      if (done) emitTerminal("study.done", { reason });
      else if (reason === "max_session_seconds")
        emitTerminal("session.ended", { reason: "max_session_seconds", terminal: true });
      else emitTerminal("session.ended", { reason });
    }
  }

  return { sessionId, done, toolCalls, reason };
}

/** Pull a custom tool-use out of an event, tolerating a few shapes across SDK versions. */
export function extractToolUse(event) {
  // Direct event form. `agent.custom_tool_use` is the live managed-agents shape
  // (managed-agents-2026-04-01); the others are tolerated for older builds/tests.
  if (
    event?.type === "agent.custom_tool_use" ||
    event?.type === "assistant.custom_tool_use" ||
    event?.type === "custom_tool_use"
  ) {
    return { id: event.custom_tool_use_id ?? event.id, name: event.name, input: event.input };
  }
  // Content-block form on an assistant message.
  const blocks = event?.message?.content ?? event?.content;
  if (Array.isArray(blocks)) {
    const tu = blocks.find((b) => b?.type === "custom_tool_use" || b?.type === "tool_use");
    if (tu) return { id: tu.id ?? tu.custom_tool_use_id, name: tu.name, input: tu.input };
  }
  return null;
}

/**
 * Done check. Prefer the Outcomes preview verdict when enabled; otherwise grade
 * against docs/rubric.json via the control plane (no preview access required).
 * Returns the raw grade so callers can distinguish a real verdict from a grade error.
 */
export async function isDone({ studyId, controlPlane, outcomesEnabled, session, sessionId }) {
  if (outcomesEnabled && session?.getOutcome) {
    try {
      const outcome = await session.getOutcome(sessionId);
      if (outcome?.status === "satisfied" || outcome?.verdict === "done") return { done: true };
    } catch {
      /* fall through to rubric grade */
    }
  }
  const grade = await controlPlane.post("/api/grade", { study_id: studyId });
  if (grade?.error) return { done: false, error: grade.error, detail: grade.detail };
  return { done: grade?.verdict === "done" };
}

/**
 * Gated done check: never treats a FAILED grade as "not done" silently. On a grade
 * `{error}` it emits a `grade.error` frame and treats the verdict as inconclusive,
 * retrying ONCE before giving up (returns false, i.e. keep going / let the session
 * end naturally — never falsely report done). Returns a boolean for the loop.
 */
export async function isDoneGated({ studyId, controlPlane, outcomesEnabled, session, sessionId, emit = () => {} }) {
  let res = await isDone({ studyId, controlPlane, outcomesEnabled, session, sessionId });
  if (res.error) {
    emit({ kind: "grade.error", study_id: studyId, error: res.error, detail: res.detail, attempt: 1 });
    res = await isDone({ studyId, controlPlane, outcomesEnabled, session, sessionId });
    if (res.error) {
      emit({ kind: "grade.error", study_id: studyId, error: res.error, detail: res.detail, attempt: 2, inconclusive: true });
      return false;
    }
  }
  return res.done === true;
}
