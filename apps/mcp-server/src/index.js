#!/usr/bin/env node
/**
 * Labmate MCP server (stdio).
 *
 * Exposes a SMALL, SEMANTIC tool surface so Claude steers the scientific loop, not
 * the database or Modal directly. Each tool here is a thin wrapper that calls the
 * Cloudflare control-plane API (apps/web) using LABMATE_INTERNAL_TOKEN, or the Modal
 * runner (MODAL_RUNNER_URL) for launches.
 *
 * This is a STARTER: tool schemas are defined; each handler has a TODO to call the
 * control plane. Keep handlers thin — business logic lives in the Worker + runner.
 *
 * Run locally:  node src/index.js   (or `npm run dev`)
 * Register in Claude Code via .mcp.json (see repo root .mcp.json).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API = process.env.LABMATE_PUBLIC_URL || "http://localhost:8788";
const TOKEN = process.env.LABMATE_INTERNAL_TOKEN || "";
const MODAL_RUNNER_URL = process.env.MODAL_RUNNER_URL || "";

async function api(pathname, body) {
  // TODO: POST to `${API}${pathname}` with Authorization: Bearer ${TOKEN}.
  // Return parsed JSON. Throw on non-2xx with a readable message.
  // const res = await fetch(`${API}${pathname}`, { method: "POST",
  //   headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  //   body: JSON.stringify(body) });
  // if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`);
  // return res.json();
  throw new Error(`TODO: implement control-plane call for ${pathname}`);
}

/**
 * Tool definitions. Keep these high-level and business-facing.
 */
const TOOLS = [
  {
    name: "create_study",
    description:
      "Create a study from a brief. The human gives business judgment; this opens the evidence ledger.",
    inputSchema: {
      type: "object",
      required: ["brief", "dataset_id", "target", "metric"],
      properties: {
        brief: { type: "string", description: "Business objective in plain language." },
        dataset_id: { type: "string" },
        target: { type: "string", description: "Target column / quantity to predict." },
        metric: { type: "string", description: "Primary metric (e.g. recall_at_fpr)." },
        constraints: { type: "object", description: "Guardrails, banned columns, interpretability needs." },
        budget: { type: "object", description: "{ max_trials, budget_seconds }." },
      },
    },
  },
  {
    name: "profile_dataset",
    description:
      "Profile a study's dataset: row count, dtypes, missingness, candidate target, dates, categoricals, and candidate leakage columns. Writes the data contract.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: { study_id: { type: "string" } },
    },
  },
  {
    name: "propose_experiments",
    description:
      "Propose N hypothesis-driven experiment cards (hypothesis, rationale, model family, features, expected outcome, cost). NOT parameter sweeps.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: {
        study_id: { type: "string" },
        n: { type: "integer", default: 6, minimum: 1, maximum: 12 },
      },
    },
  },
  {
    name: "request_approval",
    description:
      "Ask the human to approve a set of experiments before compute is launched. Pauses the loop at a checkpoint.",
    inputSchema: {
      type: "object",
      required: ["study_id", "experiment_ids", "reason"],
      properties: {
        study_id: { type: "string" },
        experiment_ids: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        estimated_cost: { type: "object", description: "{ trials, seconds }." },
      },
    },
  },
  {
    name: "launch_experiment",
    description:
      "Launch ONE approved experiment manifest on the fixed Modal runner. Logs metrics, params, artifacts, rationale, hypothesis_id, and provenance. Requires a recorded approval.",
    inputSchema: {
      type: "object",
      required: ["study_id", "experiment_manifest"],
      properties: {
        study_id: { type: "string" },
        experiment_manifest: {
          type: "object",
          description: "Conforms to packages/schemas/experiment_manifest.schema.json.",
        },
      },
    },
  },
  {
    name: "query_runs",
    description:
      "Query runs in the evidence ledger by metric, feature set, model family, hypothesis, or critique. The agent-native read path.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: {
        study_id: { type: "string" },
        filters: {
          type: "object",
          description: "e.g. { metric: 'recall', model_family: 'random_forest', critique: 'test_set_tuning' }",
        },
      },
    },
  },
  {
    name: "record_human_feedback",
    description:
      "Record human guidance and parse natural language into structured constraints (primary_metric, guardrail, banned features, budget, segment focus). Affects later experiments.",
    inputSchema: {
      type: "object",
      required: ["study_id", "feedback"],
      properties: {
        study_id: { type: "string" },
        target_id: { type: "string", description: "Optional study/hypothesis/run the feedback targets." },
        feedback: {
          type: "object",
          description: "{ type, scope, content, parsed_constraints? }",
        },
      },
    },
  },
  {
    name: "write_report",
    description:
      "Generate the final report / model card (objective, data, split, experiments, best-vs-baseline, critiques, human feedback, risks, next steps, reproducible command, provenance). Stores the artifact.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: {
        study_id: { type: "string" },
        report_type: { type: "string", enum: ["model_card", "summary"], default: "model_card" },
      },
    },
  },
  {
    name: "grade_study_against_rubric",
    description:
      "Grade the study against docs/rubric.json and return pass/fail per required check, including caught_an_issue. This is how 'done' is verified without a human.",
    inputSchema: {
      type: "object",
      required: ["study_id"],
      properties: { study_id: { type: "string" } },
    },
  },
];

/** Map tool name -> control-plane path. Implement `api()` above and these light up. */
const ROUTES = {
  create_study: "/api/studies",
  profile_dataset: "/api/profile",
  propose_experiments: "/api/experiments/propose",
  request_approval: "/api/approvals/request",
  launch_experiment: "/api/experiments/launch",
  query_runs: "/api/runs/query",
  record_human_feedback: "/api/feedback",
  write_report: "/api/reports",
  grade_study_against_rubric: "/api/grade",
};

const server = new Server(
  { name: "labmate", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const route = ROUTES[name];
  if (!route) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await api(route, args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Tool ${name} not yet wired: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[labmate-mcp] server up on stdio. API:", API, "Modal:", MODAL_RUNNER_URL || "(unset)");
