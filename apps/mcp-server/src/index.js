#!/usr/bin/env node
/**
 * Labmate MCP server (stdio).
 *
 * Exposes a SMALL, SEMANTIC tool surface so Claude steers the scientific loop, not the
 * database or Modal directly. Each tool is a thin wrapper that calls one control-plane
 * route (apps/web) with the shared LABMATE_INTERNAL_TOKEN. Business logic lives in the
 * Worker + the fixed Modal runner — these handlers only shape arguments and forward.
 *
 * Run locally:  node src/index.js   (or `npm run dev`)
 * Register in Claude Code via .mcp.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API = (process.env.LABMATE_PUBLIC_URL || "http://localhost:8787").replace(/\/$/, "");
const TOKEN = process.env.LABMATE_INTERNAL_TOKEN || "";
const MODAL_RUNNER_URL = process.env.MODAL_RUNNER_URL || "";

/** POST (or GET) a control-plane route and return parsed JSON; throw a readable error on non-2xx. */
async function api(pathname, body, method = "POST") {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(method === "GET" ? {} : { authorization: `Bearer ${TOKEN}` }),
    },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${pathname} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Tool definitions — high-level and business-facing. Each maps to a route via build().
 */
const TOOLS = [
  {
    name: "create_study",
    description: "Create a study from a brief. The human gives business judgment; this opens the evidence ledger.",
    inputSchema: {
      type: "object",
      required: ["brief", "dataset_id", "target", "metric"],
      properties: {
        brief: { type: "string", description: "Business objective in plain language." },
        owner: { type: "string" },
        task_type: { type: "string", enum: ["binary_classification", "regression"] },
        dataset_id: { type: "string" },
        target: { type: "string", description: "Target column / quantity to predict." },
        metric: { type: "string", description: "Primary metric (e.g. recall_at_fpr)." },
        metric_rationale: { type: "string" },
        constraints: { type: "object", description: "Guardrails, banned columns, interpretability needs." },
        budget: { type: "object", description: "{ max_trials, budget_seconds }." },
      },
    },
    build: (a) => ({ path: "/api/studies", body: a }),
  },
  {
    name: "profile_dataset",
    description:
      "Profile a study's dataset: row count, dtypes, missingness, candidate leakage columns, split + seed. Writes the data contract.",
    inputSchema: { type: "object", required: ["study_id"], properties: { study_id: { type: "string" } } },
    build: (a) => ({ path: "/api/profile", body: { study_id: a.study_id } }),
  },
  {
    name: "propose_experiments",
    description:
      "Propose N hypothesis-driven experiment cards (hypothesis, rationale, model family, features, expected outcome). NOT parameter sweeps.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: { study_id: { type: "string" }, n: { type: "integer", default: 6, minimum: 1, maximum: 12 } },
    },
    build: (a) => ({ path: "/api/experiments/propose", body: { study_id: a.study_id, n: a.n ?? 6 } }),
  },
  {
    name: "request_approval",
    description:
      "Ask the human to approve a set of experiments before compute is launched. Pauses the loop at a checkpoint.",
    inputSchema: {
      type: "object",
      required: ["study_id", "reason"],
      properties: {
        study_id: { type: "string" },
        experiment_ids: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        estimated_cost_seconds: { type: "integer" },
      },
    },
    build: (a) => ({ path: "/api/approvals/request", body: a }),
  },
  {
    name: "launch_experiment",
    description:
      "Launch ONE approved experiment manifest on the fixed Modal runner. Records metrics, params, artifacts, rationale, hypothesis_id, and provenance. Requires a recorded approval (else 402); rejects banned columns / tune_on=test (422).",
    inputSchema: {
      type: "object",
      required: ["manifest"],
      properties: {
        manifest: { type: "object", description: "Conforms to packages/schemas/experiment_manifest.schema.json." },
        approval_id: { type: "string", description: "The approval authorizing this compute." },
      },
    },
    build: (a) => ({ path: "/api/experiments/launch", body: { manifest: a.manifest, approval_id: a.approval_id } }),
  },
  {
    name: "query_runs",
    description:
      "Query runs in the ledger by metric thresholds, model family, hypothesis, tags, or linked critique kind. The agent-native read path.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: {
        study_id: { type: "string" },
        model_family: { type: "string" },
        hypothesis_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        critique_kind: { type: "string", enum: ["leakage", "test_set_tuning", "metric", "calibration", "robustness"] },
        metric_filters: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "op", "value"],
            properties: {
              name: { type: "string" },
              op: { type: "string", enum: ["<", "<=", "=", ">=", ">"] },
              value: { type: "number" },
            },
          },
        },
      },
    },
    build: (a) => ({ path: "/api/runs/query", body: a }),
  },
  {
    name: "record_human_feedback",
    description:
      "Record human guidance and parse natural language into structured constraints (primary_metric, guardrail, banned features, budget, segment). An approval is feedback of type=approval. Affects later experiments.",
    inputSchema: {
      type: "object",
      required: ["study_id", "type", "content"],
      properties: {
        study_id: { type: "string" },
        target_id: { type: "string" },
        type: {
          type: "string",
          enum: ["approval", "ban_feature", "change_metric", "increase_budget", "focus_segment", "note"],
        },
        scope: { type: "string", enum: ["study", "hypothesis", "run", "experiment"] },
        content: { type: "string" },
        parsed_constraints: { type: "object" },
      },
    },
    build: (a) => ({ path: "/api/feedback", body: a }),
  },
  {
    name: "record_critique",
    description:
      "Record a methodological critique of a run (leakage, test_set_tuning, metric, calibration, robustness) with a finding, recommendation, and the decision it led to.",
    inputSchema: {
      type: "object",
      required: ["study_id", "kind", "finding"],
      properties: {
        study_id: { type: "string" },
        target_run_id: { type: "string" },
        kind: { type: "string", enum: ["leakage", "test_set_tuning", "metric", "calibration", "robustness"] },
        finding: { type: "string" },
        recommendation: { type: "string" },
        led_to_decision: { type: "string", enum: ["promote", "reject", "rerun", "branch", "stop"] },
      },
    },
    build: (a) => ({ path: "/api/critiques", body: a }),
  },
  {
    name: "record_decision",
    description: "Record a decision (promote/reject/rerun/branch/stop) naming the run it acted on and the reason.",
    inputSchema: {
      type: "object",
      required: ["study_id", "action"],
      properties: {
        study_id: { type: "string" },
        action: { type: "string", enum: ["promote", "reject", "rerun", "branch", "stop"] },
        promoted_run_id: { type: "string" },
        rejected_run_id: { type: "string" },
        reason: { type: "string" },
      },
    },
    build: (a) => ({ path: "/api/decisions", body: a }),
  },
  {
    name: "write_report",
    description:
      "Generate the final model card (objective, data, split, experiments, best-vs-baseline, critiques, feedback, risks, reproducible command, provenance). Stores it in R2 and records a report artifact.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: {
        study_id: { type: "string" },
        report_type: { type: "string", enum: ["model_card", "summary"], default: "model_card" },
      },
    },
    build: (a) => ({ path: "/api/reports", body: a }),
  },
  {
    name: "grade_study_against_rubric",
    description:
      "Grade the study against docs/rubric.json and return pass/fail per required check, including caught_an_issue. How 'done' is verified without a human.",
    inputSchema: { type: "object", required: ["study_id"], properties: { study_id: { type: "string" } } },
    build: (a) => ({ path: "/api/grade", body: { study_id: a.study_id } }),
  },
  {
    name: "get_study",
    description: "Read the whole evidence ledger for a study (dataset version, hypotheses, runs, critiques, decisions, feedback, artifacts, recommendation).",
    inputSchema: { type: "object", required: ["study_id"], properties: { study_id: { type: "string" } } },
    build: (a) => ({ path: `/api/studies/${encodeURIComponent(a.study_id)}`, method: "GET" }),
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

const server = new Server({ name: "labmate", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOL_BY_NAME[name];
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const { path, body, method } = tool.build(args ?? {});
    const result = await api(path, body, method || "POST");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Tool ${name} failed: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[labmate-mcp] up on stdio. API:", API, "Modal:", MODAL_RUNNER_URL || "(unset, Worker-side)");
