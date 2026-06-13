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

export function makeDispatcher(deps) {
  const { controlPlane, modal, onApprovalNeeded } = deps;

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
      // Create a pending approval and notify the cockpit. For the autonomous demo
      // the control plane may auto-approve within budget; otherwise this blocks
      // until a human approves in the UI (onApprovalNeeded surfaces it).
      const res = await controlPlane.post("/api/approvals/request", input);
      if (onApprovalNeeded) await onApprovalNeeded(input, res);
      return res; // { approval_id, status }
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
      // The control plane records the run, verifies the approval, and forwards the
      // manifest to the Modal runner. We call it (not Modal directly) so the run is
      // persisted with provenance and the approval is checked server-side.
      // It relays the runner's 422 for banned columns / tune_on=test unchanged.
      return controlPlane.post("/api/experiments/launch", {
        approval_id: input.approval_id,
        manifest: input.manifest,
      });
    },

    async query_runs(input) {
      return controlPlane.post("/api/runs/query", input);
    },

    async record_critique(input) {
      return controlPlane.post("/api/critiques", input);
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
