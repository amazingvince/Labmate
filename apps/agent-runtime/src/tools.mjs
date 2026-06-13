/**
 * Custom tool DEFINITIONS handed to the Managed Agent.
 *
 * These mirror the semantic MCP tools and the OpenAPI contract
 * (apps/api-spec/openapi.yaml) — same names, same shapes — so the agent reasons in
 * Labmate's domain ("launch an experiment") rather than over raw HTTP/SQL.
 *
 * The runtime catches each tool-use on the event stream and executes it in
 * dispatch.mjs, returning a user.custom_tool_result. Keep this list small and
 * semantic; it is the agent's entire action surface.
 *
 * Tool schema follows the standard Anthropic tool shape (name, description,
 * input_schema). Confirm the exact custom-tool envelope for managed agents in the
 * Tools doc before the demo:
 *   https://platform.claude.com/docs/en/managed-agents/tools
 */

export const LABMATE_TOOLS = [
  {
    name: "profile_dataset",
    description:
      "Profile the study's dataset: column dtypes, missingness, candidate leakage " +
      "columns, and a deterministic split. Call this first. Returns the data contract.",
    input_schema: {
      type: "object",
      properties: { study_id: { type: "string" } },
      required: ["study_id"],
    },
  },
  {
    name: "propose_experiments",
    description:
      "Propose N hypothesis cards (statement, rationale, model family, candidate " +
      "features, expected outcome) for the human to approve. Each must exclude " +
      "banned/leaky columns from its features.",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string" },
        hypotheses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              statement: { type: "string" },
              rationale: { type: "string" },
              model_family: { type: "string" },
              features: { type: "array", items: { type: "string" } },
              expected_outcome: { type: "string" },
            },
            required: ["statement", "model_family", "features"],
          },
        },
      },
      required: ["study_id", "hypotheses"],
    },
  },
  {
    name: "request_approval",
    description:
      "Request approval before spending compute or unbanning a leaky feature. " +
      "Returns { approval_id, status }: status is 'approved' when auto-granted within " +
      "the study's budget, or 'pending' until a human approves in the cockpit. Only " +
      "call launch_experiment once you hold an approval_id whose status is 'approved'.",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string" },
        experiment_ids: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        estimated_cost_seconds: { type: "integer" },
      },
      required: ["study_id", "reason"],
    },
  },
  {
    name: "launch_experiment",
    description:
      "Run ONE experiment by submitting a Python training SCRIPT to a network-isolated " +
      "Modal Sandbox (the only executor — no code runs on your own host). Requires an " +
      "approval id. Write a self-contained Python script that reads the CSV at " +
      "/work/data.csv, does a deterministic split FIRST using the declared seed, " +
      "trains, tunes ONLY on validation, evaluates on test once, and writes " +
      "/work/result.json := {metrics:{recall_at_fpr, precision, false_positive_rate, " +
      "roc_auc, pr_auc, ...}, params:{...}, artifacts:{...}}. pandas/numpy/scikit-learn " +
      "are installed; the sandbox has NO network. Exclude banned/leaky columns from " +
      "features. The runner rejects scripts whose declared features include a banned " +
      "column or whose tune_on=test. Returns the run id with metrics once complete.",
    input_schema: {
      type: "object",
      properties: {
        approval_id: { type: "string" },
        manifest: {
          type: "object",
          description:
            "The experiment to run as an agent-authored script. The script reads " +
            "/work/data.csv and writes /work/result.json with metrics/params/artifacts.",
          properties: {
            study_id: { type: "string" },
            hypothesis_id: { type: "string" },
            script: {
              type: "string",
              description:
                "Self-contained Python. Reads /work/data.csv, splits deterministically " +
                "with the declared seed FIRST, trains, tunes on validation only, " +
                "evaluates on test once, and writes /work/result.json.",
            },
            features: {
              type: "array",
              items: { type: "string" },
              description: "The columns the script uses; MUST exclude banned/leaky columns.",
            },
            split: {
              type: "object",
              properties: {
                strategy: { type: "string" },
                time_col: { type: "string" },
                ratios: { type: "array", items: { type: "number" } },
                seed: { type: "integer" },
              },
              required: ["seed"],
            },
            tune_on: { type: "string", default: "validation" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["study_id", "hypothesis_id", "script", "features", "split"],
        },
      },
      required: ["approval_id", "manifest"],
    },
  },
  {
    name: "query_runs",
    description:
      "Query the study's runs by metric thresholds, model family, hypothesis, tags, " +
      "or linked critique kind. Use to compare runs and decide what to do next.",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string" },
        model_family: { type: "string" },
        hypothesis_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        critique_kind: { type: "string" },
        metric_filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              op: { type: "string", enum: ["<", "<=", "=", ">=", ">"] },
              value: { type: "number" },
            },
            required: ["name", "op", "value"],
          },
        },
      },
      required: ["study_id"],
    },
  },
  {
    name: "record_critique",
    description:
      "Record a methodological critique of a run (leakage, test_set_tuning, metric, " +
      "calibration, robustness) with a recommendation and the decision it leads to " +
      "(promote/reject/rerun/branch/stop). This is the review step of the loop.",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string" },
        target_run_id: { type: "string" },
        kind: {
          type: "string",
          enum: ["leakage", "test_set_tuning", "metric", "calibration", "robustness"],
        },
        finding: { type: "string" },
        recommendation: { type: "string" },
        led_to_decision: {
          type: "string",
          enum: ["promote", "reject", "rerun", "branch", "stop"],
        },
      },
      required: ["study_id", "kind", "finding"],
    },
  },
  {
    name: "record_decision",
    description:
      "Record a decision about the study after reviewing runs: promote the best " +
      "run as the result, or reject/rerun/branch/stop. Always record a promote " +
      "decision for the run you select at the end (with its run id and a reason), " +
      "and pair the promoted run with a critique (target_run_id = that run).",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string" },
        action: { type: "string", enum: ["promote", "reject", "rerun", "branch", "stop"] },
        promoted_run_id: { type: "string" },
        rejected_run_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["study_id", "action"],
    },
  },
  {
    name: "write_report",
    description:
      "Generate the final model card (objective, data, split, experiments table, " +
      "best vs baseline, risks, rejected ideas, next steps, reproducible command, " +
      "provenance) and store it. Call when the study is done.",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string" },
        report_type: { type: "string", enum: ["model_card", "summary"] },
      },
      required: ["study_id"],
    },
  },
];

/** Names the dispatcher must handle. Used by the smoke test to assert coverage. */
export const LABMATE_TOOL_NAMES = LABMATE_TOOLS.map((t) => t.name);
