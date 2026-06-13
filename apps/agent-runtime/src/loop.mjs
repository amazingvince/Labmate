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

/**
 * @param {object} o
 * @param {string} o.studyId
 * @param {object} o.agent      adapter: { createSession, sendUserMessage, sendToolResult, streamEvents }
 * @param {object} o.dispatcher from makeDispatcher()
 * @param {object} o.controlPlane control-plane client (for the done check)
 * @param {(evt: object) => void} [o.emit] called for every event worth showing the human
 * @param {object} [o.opts]      { agentId, environmentId, maxToolCalls, outcomesEnabled, brief }
 */
export async function runStudyLoop({ studyId, agent, dispatcher, controlPlane, emit = () => {}, opts = {} }) {
  const {
    agentId,
    environmentId,
    maxToolCalls = 60,
    outcomesEnabled = false,
    brief, // { text } — the message that kicks off the work
  } = opts;

  const session = await agent.createSession({
    agentId,
    environmentId,
    title: `Labmate study ${studyId}`,
    metadata: { study_id: studyId },
  });
  const sessionId = session.id;
  emit({ kind: "session.created", study_id: studyId, session_id: sessionId });

  // Kick off the work.
  const kickoff =
    brief?.text ??
    `You are running Labmate study ${studyId}. Profile the dataset, review it for ` +
      `leakage, propose experiments (asking approval before compute), launch them in ` +
      `the Modal sandbox, critique each result, and iterate until the rubric is met. ` +
      `Start by calling profile_dataset for this study.`;
  await agent.sendUserMessage(sessionId, kickoff);
  emit({ kind: "user.message", study_id: studyId, text: kickoff });

  let toolCalls = 0;
  let done = false;

  for await (const event of agent.streamEvents(sessionId)) {
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

    // 2. Custom tool-use → execute for real → return the result.
    const toolUse = extractToolUse(event);
    if (toolUse) {
      toolCalls += 1;
      emit({ kind: "tool.use", study_id: studyId, name: toolUse.name, input: toolUse.input });

      if (toolCalls > maxToolCalls) {
        await agent.sendUserMessage(
          sessionId,
          "Tool-call budget reached. Write the report with what you have and stop.",
        );
        continue;
      }

      const result = await dispatcher.dispatch(toolUse.name, toolUse.input ?? {});
      emit({ kind: "tool.result", study_id: studyId, name: toolUse.name, result });
      await agent.sendToolResult(sessionId, toolUse.id, JSON.stringify(result), Boolean(result?.error));

      // After a report is written, check whether we're done.
      if (toolUse.name === "write_report") {
        done = await isDone({ studyId, controlPlane, outcomesEnabled, session: agent, sessionId });
        if (done) {
          emit({ kind: "study.done", study_id: studyId });
          break;
        }
      }
      continue;
    }

    // 3. The agent went idle. On the live API `session.status_idle` carries a
    // `stop_reason`: `requires_action` means it's blocked waiting on a tool
    // result we still owe it (or a confirmation) — do NOT nudge, just continue;
    // anything else (`end_turn`, `retries_exhausted`) is a real stopping point
    // where we check done and otherwise nudge the next step.
    if (
      type === "session.status_idle" ||
      type === "session.awaiting_input" ||
      type === "session.idle" ||
      type === "awaiting_input"
    ) {
      const stop = event.stop_reason?.type ?? event.stopReason?.type;
      if (stop === "requires_action") {
        continue; // mid-tool-result; the tool-use branch handles the response
      }
      done = await isDone({ studyId, controlPlane, outcomesEnabled, session: agent, sessionId });
      if (done) {
        emit({ kind: "study.done", study_id: studyId });
        break;
      }
      await agent.sendUserMessage(
        sessionId,
        "Review the latest runs with query_runs. If an experiment beat the baseline " +
          "and survives a leakage/calibration check, promote it and write_report. " +
          "Otherwise propose the next experiment (request approval first) or stop.",
      );
      emit({ kind: "nudge", study_id: studyId });
      continue;
    }

    // 4. Terminal session states.
    if (
      type === "session.status_terminated" ||
      type === "session.completed" ||
      type === "session.failed" ||
      type === "completed"
    ) {
      emit({ kind: "session.ended", study_id: studyId, event });
      break;
    }
  }

  return { sessionId, done, toolCalls };
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
 */
export async function isDone({ studyId, controlPlane, outcomesEnabled, session, sessionId }) {
  if (outcomesEnabled && session?.getOutcome) {
    try {
      const outcome = await session.getOutcome(sessionId);
      if (outcome?.status === "satisfied" || outcome?.verdict === "done") return true;
    } catch {
      /* fall through to rubric grade */
    }
  }
  const grade = await controlPlane.post("/api/grade", { study_id: studyId });
  return grade?.verdict === "done";
}
