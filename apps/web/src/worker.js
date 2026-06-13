/**
 * Labmate Cloudflare Worker — control plane API + cockpit.
 *
 * Routes (all POST unless noted) mirror the MCP tool surface:
 *   POST /api/studies               create_study
 *   POST /api/profile               profile_dataset
 *   POST /api/experiments/propose   propose_experiments
 *   POST /api/approvals/request     request_approval
 *   POST /api/experiments/launch    launch_experiment   (-> Modal runner)
 *   POST /api/runs/query            query_runs
 *   POST /api/feedback              record_human_feedback
 *   POST /api/reports               write_report        (-> R2)
 *   POST /api/grade                 grade_study_against_rubric (vs docs/rubric.json)
 *   GET  /                          cockpit UI
 *   GET  /api/studies/:id           study detail (cards, runs, critiques, feedback)
 *
 * This is a STARTER: routing + auth + bindings are wired; each handler has a TODO.
 * Bindings (see wrangler.toml): env.DB (D1), env.ARTIFACTS (R2), env.STUDY (Durable Object).
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

/** Require the shared internal token on /api/* writes from the MCP server. */
function checkAuth(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return token && env.LABMATE_INTERNAL_TOKEN && token === env.LABMATE_INTERNAL_TOKEN;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Cockpit UI
    if (request.method === "GET" && pathname === "/") {
      return new Response(COCKPIT_HTML, { headers: { "content-type": "text/html" } });
    }

    // Public read: study detail (cockpit fetches this)
    if (request.method === "GET" && pathname.startsWith("/api/studies/")) {
      const id = pathname.split("/").pop();
      // TODO: SELECT study + hypotheses + runs + critiques + feedback from env.DB and return.
      return json({ todo: "study detail", id });
    }

    // Writes require the internal token.
    if (pathname.startsWith("/api/")) {
      if (!checkAuth(request, env)) return unauthorized();
      const body = await request.json().catch(() => ({}));

      switch (pathname) {
        case "/api/studies":
          // TODO: insert study + dataset_version stub; return { id }.
          return json({ todo: "create_study", received: body });
        case "/api/profile":
          // TODO: profile dataset (delegate heavy work to Modal or precomputed),
          // write dataset_version with leakage_candidates + split_strategy + seed.
          return json({ todo: "profile_dataset", received: body });
        case "/api/experiments/propose":
          // TODO: insert N hypothesis rows; return cards.
          return json({ todo: "propose_experiments", received: body });
        case "/api/approvals/request":
          // TODO: create an approval request; cockpit surfaces it; returns pending id.
          return json({ todo: "request_approval", received: body });
        case "/api/experiments/launch": {
          // TODO: verify approval exists; build manifest; POST to MODAL_RUNNER_URL;
          // insert run (status running -> completed) with metrics/params/artifacts/provenance.
          return json({ todo: "launch_experiment", received: body });
        }
        case "/api/runs/query":
          // TODO: SELECT runs filtered by metric/model_family/hypothesis/critique.
          return json({ todo: "query_runs", received: body });
        case "/api/feedback":
          // TODO: insert feedback; parse NL -> parsed_constraints_json.
          return json({ todo: "record_human_feedback", received: body });
        case "/api/reports": {
          // TODO: assemble model card; store in env.ARTIFACTS (R2) with provenance;
          // insert an artifact row of kind 'report'.
          return json({ todo: "write_report", received: body });
        }
        case "/api/grade":
          // TODO: load docs/rubric.json (bundle it), evaluate each required check
          // against env.DB for the study, return pass/fail per check + overall verdict.
          return json({ todo: "grade_study_against_rubric", received: body });
        default:
          return json({ error: "not found", pathname }, 404);
      }
    }

    return json({ error: "not found", pathname }, 404);
  },
};

/**
 * Durable Object: one instance per study session. Holds live state and an event
 * stream so the cockpit can update as runs complete. (Nice-to-have for the rubric.)
 */
export class StudySession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }
  async fetch(request) {
    // TODO: handle WebSocket upgrade for live updates; broadcast run/critique events.
    return new Response("StudySession DO — TODO: live event stream");
  }
}

/** Minimal cockpit shell. Replace with the real four-pane mission control. */
const COCKPIT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Labmate — mission control</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; }
    header { padding: 16px 20px; border-bottom: 1px solid #8884; }
    main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px; }
    section { border: 1px solid #8884; border-radius: 12px; padding: 16px; }
    h1 { font-size: 18px; margin: 0; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
    .muted { opacity: .6; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <h1>Labmate — mission control</h1>
    <div class="muted">Brief + rubric · Experiment cards · Evidence ledger · Current recommendation</div>
  </header>
  <main>
    <section><h2>Brief + rubric</h2><p class="muted">TODO: render study brief, metric, guardrails, budget, and "done" criteria.</p></section>
    <section><h2>Experiment cards</h2><p class="muted">TODO: hypothesis, expected impact, cost, status, latest metric, agent rationale, approve/deny/rerun.</p></section>
    <section><h2>Evidence ledger</h2><p class="muted">TODO: timeline of runs, notes, critiques, and human feedback.</p></section>
    <section><h2>Current recommendation</h2><p class="muted">TODO: e.g. "Promote model 7, but only after calibration check."</p></section>
  </main>
  <script>
    // TODO: fetch /api/studies/:id and render the four panes; subscribe to the DO event stream.
  </script>
</body>
</html>`;
