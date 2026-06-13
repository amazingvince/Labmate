#!/usr/bin/env node
/**
 * demo:e2e — drive the whole end-to-end demo on the SEEDED study, deterministically.
 *
 *   npm run demo:e2e
 *
 * This is the script you run on stage. It:
 *   1. checks the required keys + the bootstrapped agent/environment IDs exist,
 *   2. creates the seeded sla_tickets study via the control plane,
 *   3. tells the running agent runtime to start the session,
 *   4. tails the runtime's SSE stream and prints a readable activity log,
 *   5. stops when the study grades `done` (or a max wait elapses), then prints the
 *      report URL.
 *
 * Prerequisites (the script checks and tells you what's missing):
 *   - .env filled (ANTHROPIC_API_KEY, MODAL_*, CLOUDFLARE_*, LABMATE_INTERNAL_TOKEN)
 *   - `npm run agent:bootstrap` has set LABMATE_AGENT_ID / LABMATE_ENVIRONMENT_ID
 *   - control plane reachable (wrangler dev or deployed) at LABMATE_PUBLIC_URL
 *   - agent runtime running:  npm run agent:dev   (at AGENT_RUNTIME_PORT)
 *   - Modal runner deployed:  MODAL_RUNNER_URL set
 *
 * It uses only Node built-ins. Keep it boring and legible — it runs live.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- load .env -------------------------------------------------------------
const env = {};
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  // Tolerate both `KEY=value` and `KEY: value` (the repo .env uses the colon form);
  // separator is the first `=` or `:` so values with `:` (URLs) parse correctly.
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    const i = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    env[k] = v;
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
const get = (k, fb) => process.env[k] ?? env[k] ?? fb;

// --- preflight -------------------------------------------------------------
// Hard requirements for the runtime to start a session and drive the loop.
const required = ["ANTHROPIC_API_KEY", "LABMATE_INTERNAL_TOKEN", "LABMATE_AGENT_ID", "LABMATE_ENVIRONMENT_ID"];
const missing = required.filter((k) => !get(k));
if (missing.length) {
  console.error("Cannot run the demo — missing:\n  " + missing.join("\n  "));
  console.error("\nFill .env and run `npm run agent:bootstrap` first (see docs/GOAL_E2E.md).");
  process.exit(1);
}
// MODAL_RUNNER_URL belongs to the control-plane Worker (wrangler var), not this
// script — warn if it's not visible here, but don't block: launches will 502 from
// the Worker if it isn't set there.
if (!get("MODAL_RUNNER_URL")) {
  console.warn("⚠️  MODAL_RUNNER_URL not set in this env — ensure the control-plane Worker has it (wrangler var / .dev.vars), or launches will 502.");
}

// Everything goes through the control plane (the deployed Worker), which triggers
// the agent runtime on study create and proxies its SSE — so this driver works
// whether the runtime is local or Modal-hosted, with no direct runtime address.
const controlPlane = (get("LABMATE_PUBLIC_URL", "http://127.0.0.1:8787")).replace(/\/$/, "");
const token = get("LABMATE_INTERNAL_TOKEN");
const MAX_WAIT_MS = 1000 * 60 * 12; // 12 minutes

async function cp(path, body) {
  const res = await fetch(`${controlPlane}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// --- the seeded study brief ------------------------------------------------
const brief = {
  brief:
    "Predict which support tickets will breach SLA. Optimize recall at an acceptable " +
    "false-positive cost. Do not use fields created after ticket close.",
  owner: "demo@labmate",
  task_type: "binary_classification",
  dataset_id: "sla_tickets",
  target: "breached_sla",
  metric: "recall_at_fpr",
  metric_rationale: "Missed breaches cost more than false alarms up to 20% FPR.",
  constraints: {
    primary_metric: "recall",
    guardrails: [{ expr: "false_positive_rate <= 0.20" }],
    banned_columns: ["resolved_at", "time_to_resolution", "closed_status", "agent_notes_final"],
  },
  budget: { max_trials: 20, budget_seconds: 600 },
};

const indent = (s, pad = "        ") => String(s ?? "").split("\n").map((l) => pad + l).join("\n");

function log(evt) {
  const t = new Date().toLocaleTimeString();
  const k = evt.kind ?? evt.type ?? "event";
  if (k === "agent.activity") {
    const content = evt.event?.content ?? evt.event?.message?.content;
    const text = Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
    if (text.trim()) console.info(`  ${t} 🧠\n${indent(text.trim())}`);
  } else if (k === "tool.use") {
    const inp = evt.input ?? {};
    const m = inp.manifest ?? {};
    console.info(`  ${t} 🔧 ${evt.name}`);
    if (evt.name === "launch_experiment" && m.script) {
      // The rich bit: the actual training code the agent authored for the sandbox.
      console.info(indent(`hypothesis=${m.hypothesis_id ?? "?"} features=${JSON.stringify(m.features ?? [])} tune_on=${m.tune_on ?? "validation"}`, "        · "));
      console.info(indent(m.script, "        | "));
    } else {
      const s = JSON.stringify(inp);
      console.info(indent(s.length > 600 ? s.slice(0, 600) + "…" : s, "        · "));
    }
  } else if (k === "tool.result") {
    const r = evt.result ?? {};
    if (r.error) console.info(`  ${t} ↩️  ${evt.name} → ⚠️ ${r.error}${r.http_status ? ` (${r.http_status})` : ""}${r.detail ? ": " + String(r.detail).slice(0, 200) : ""}`);
    else if (r.metrics && Object.keys(r.metrics).length) console.info(`  ${t} ↩️  ${evt.name} → ${r.id ?? "ok"}  ${Object.entries(r.metrics).map(([kk, vv]) => `${kk}=${typeof vv === "number" ? vv.toFixed(3) : vv}`).join("  ")}`);
    else console.info(`  ${t} ↩️  ${evt.name} → ${r.id ?? r.status ?? "ok"}`);
  } else if (k === "approval.needed") {
    const wait = evt.auto_approve_in_ms ? ` (auto-approving in ${Math.round(evt.auto_approve_in_ms / 1000)}s)` : "";
    console.info(`  ${t} ⏳ approval requested${wait}: ${evt.input?.reason ?? ""}`);
  } else if (k === "nudge") {
    console.info(`  ${t} 👉 nudge: review and continue, or stop`);
  } else if (k === "study.done" || k === "loop.finished") {
    console.info(`  ${t} ✅ ${k}`);
  } else if (k === "loop.error") {
    console.error(`  ${t} ❌ ${evt.error}`);
  } else {
    console.info(`  ${t} • ${k}`);
  }
}

async function tailStream(studyId, onDone) {
  // Minimal SSE client over fetch (Node 18+ streaming body). Subscribing to the
  // control plane's stream also starts the study's session if it hasn't begun.
  const res = await fetch(`${controlPlane}/api/studies/${encodeURIComponent(studyId)}/stream`, {
    headers: { accept: "text/event-stream" },
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > MAX_WAIT_MS) {
      console.error("\nTimed out waiting for the study to finish.");
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      log(evt);
      if (evt.kind === "study.done" || evt.kind === "loop.finished") {
        await onDone();
        return;
      }
    }
  }
}

async function main() {
  console.info("Labmate end-to-end demo");
  console.info("=======================");
  console.info(`control plane: ${controlPlane}\n`);

  console.info("1. Creating the seeded SLA-breach study (this triggers the agent session)...");
  const created = await cp("/api/studies", brief);
  const studyId = created.id;
  console.info(`   study_id = ${studyId}\n`);

  console.info("2. Live agent activity (control plane proxies the runtime's stream):\n");
  await tailStream(studyId, async () => {
    console.info("\n3. Final grade + report:");
    const grade = await cp("/api/grade", { study_id: studyId });
    console.info(`   verdict: ${grade.verdict}`);
    try {
      const report = await cp("/api/reports", { study_id: studyId, report_type: "model_card" });
      console.info(`   report:  ${report.uri ?? "(see cockpit)"}`);
    } catch {
      /* report may already exist; the cockpit shows it */
    }
    console.info(`\n   Open the cockpit at ${get("LABMATE_PUBLIC_URL", controlPlane)} to view the ledger.`);
  });
}

main().catch((err) => {
  console.error("\nDemo failed:", err?.message ?? err);
  process.exit(1);
});
