"""
Labmate agent-runtime on Modal — a long-lived Node web server.

This wraps the Node ESM agent runtime (apps/agent-runtime/src/server.mjs) as a Modal
web server so a deployed Cloudflare Worker can proxy to it. The printed web URL becomes
AGENT_RUNTIME_URL on the Worker.

The Node server (src/server.mjs) is a node:http server that exposes:
  POST /agent/start            { study_id }   -> start a Managed-Agents session + loop
  GET  /agent/:studyId/stream  (SSE)          -> live agent events for the cockpit
  POST /agent/:studyId/message { text }       -> inject a human "suggest changes" message
  GET  /healthz
It listens on config.port (env AGENT_RUNTIME_PORT, default 8990). Node's
server.listen(port) binds 0.0.0.0 by default, which is what Modal requires (the process
must bind the external interface, not just localhost).

-------------------------------------------------------------------------------
MODAL API USED (signatures confirmed against modal.com/docs, June 2026)
-------------------------------------------------------------------------------
* modal.App("labmate-agent-runtime")
* modal.Image.from_registry(tag, secret=None, *, setup_dockerfile_commands=[],
      force_build=False, add_python=None, **kwargs)
      -> add_python="3.11" is supported (type str | None). docs/reference/modal.Image
* Image.add_local_dir(self, local_path, remote_path, *, copy=False, ignore=[])
* Image.add_local_file(self, local_path, remote_path, *, copy=False)
      -> "Set copy=True to copy the files into an Image layer at build time" and
         "it is required if you want to run additional build steps after this one."
         docs/guide/images + docs/reference/modal.Image
* Image.run_commands(self, *commands, env=None, secrets=None, volumes=None,
      gpu=None, force_build=False)
* Image.workdir(self, path)
* modal.Secret.from_name("labmate-agent-runtime")
      -> @app.function(secrets=[modal.Secret.from_name(...)]); secret keys are injected
         as environment variables. docs/guide/secrets
* @app.function(image=..., secrets=..., timeout=..., min_containers=..., max_containers=...)
      -> min_containers (int | None): "Minimum number of containers to keep warm, even
         when Function is idle." timeout default 300, raised here for multi-minute loops.
      -> max_containers (int | None): "The maximum number of containers Modal will run
         for this Function at once." Set to 1 here to pin the in-memory study registry
         to a single process (see the SINGLE-CONTAINER CONSTRAINT note below). This is
         the current (non-deprecated) cap; older code used concurrency_limit=N.
         docs/reference/modal.App
* @modal.web_server(port, *, startup_timeout=5.0, label=None, custom_domains=None,
      requires_proxy_auth=False)
      -> "expose a full HTTP server listening on a container port" — the decorated
         function must launch a process that binds the port and then return; Modal
         transparently proxies all HTTP traffic (including SSE / WebSockets) to it.
         docs/guide/webhooks + docs/reference/modal.web_server
* @modal.concurrent(max_inputs=N)
      -> lets one warm container fan out concurrent connections (multiple SSE streams).
         docs/guide/webhooks

-------------------------------------------------------------------------------
DEPLOY RUNBOOK
-------------------------------------------------------------------------------
(0) Bootstrap the Managed Agent FIRST — this prints/persists LABMATE_AGENT_ID and
    LABMATE_ENVIRONMENT_ID, which the secret in step (1) needs:

        cd apps/agent-runtime && npm install && npm run bootstrap
        # (package.json defines "bootstrap": "node src/bootstrap.mjs"; it writes
        #  LABMATE_AGENT_ID / LABMATE_ENVIRONMENT_ID to the repo .env)

(1) Create the Modal secret from the repo .env values (one key per env var the
    runtime reads). Substitute the real values:

        modal secret create labmate-agent-runtime \
          ANTHROPIC_API_KEY=sk-ant-... \
          LABMATE_INTERNAL_TOKEN=... \
          LABMATE_PUBLIC_URL=https://labmate.amazingvince.com \
          LABMATE_AGENT_ID=agent_... \
          LABMATE_ENVIRONMENT_ID=env_...

    (AGENT_RUNTIME_PORT is NOT needed in the secret — the function below forces it to
     PORT so the proxied port and the Node listen port can never drift.)

    (Optional extra keys the runtime understands: ANTHROPIC_MODEL, LABMATE_AUTO_APPROVE,
     MODAL_RUNNER_URL, LABMATE_MAX_TOOL_CALLS, LABMATE_MAX_SESSION_SECONDS,
     MANAGED_AGENTS_OUTCOMES, LABMATE_SKILL_IDS, LABMATE_APPROVAL_DELAY_MS,
     LABMATE_DEFAULT_BUDGET_SECONDS, LABMATE_DEFAULT_MAX_TRIALS,
     LABMATE_SESSION_GRACE_SECONDS.)

(2) Deploy from the repo root (so the add_local_dir/add_local_file relative paths
    resolve against this file's directory):

        modal deploy apps/agent-runtime/modal_app.py

(3) Modal prints a web URL for `agent_runtime`. That URL is AGENT_RUNTIME_URL. Set it
    on the Cloudflare Worker and redeploy:

        cd apps/web
        npx wrangler secret put AGENT_RUNTIME_URL   # paste the printed URL
        npx wrangler deploy

-------------------------------------------------------------------------------
VALIDATE (no deploy, no API calls):
    python3 -m py_compile apps/agent-runtime/modal_app.py
    python3 -c "import ast; ast.parse(open('apps/agent-runtime/modal_app.py').read())"
-------------------------------------------------------------------------------
"""

import pathlib
import subprocess

import modal

# Port the Node server binds (must match AGENT_RUNTIME_PORT in the secret). The Node
# server defaults to 8990 (src/config.mjs), and we also export AGENT_RUNTIME_PORT below
# so the two can never drift.
PORT = 8990

# Resolve local source relative to THIS file so `modal deploy` works from the repo root.
_HERE = pathlib.Path(__file__).parent  # apps/agent-runtime

# Build the image:
#   * Node 20 base, with Python 3.11 added so Modal's client can run inside.
#   * Copy ONLY src/ and package.json into /app at BUILD time (copy=True) — NOT
#     node_modules — so the subsequent `npm install` run_command can see them.
#   * Install production deps at build time (omit dev) so cold/warm starts are instant.
image = (
    modal.Image.from_registry("node:20-slim", add_python="3.11")
    .workdir("/app")
    .add_local_file(
        _HERE / "package.json",
        "/app/package.json",
        copy=True,
    )
    .add_local_dir(
        _HERE / "src",
        "/app/src",
        copy=True,
    )
    .run_commands("cd /app && npm install --omit=dev")
)

app = modal.App("labmate-agent-runtime")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("labmate-agent-runtime")],
    # Keep one container warm so SSE streams (GET /agent/:id/stream) are never cold-started.
    min_containers=1,
    # SINGLE-CONTAINER CONSTRAINT (load-bearing): the Node runtime keeps its study
    # registry — the studies Map, the SSE subscriber sets, the event buffer + monotonic
    # `id:` sequence, and the stream dedup — in PROCESS memory (src/server.mjs). That
    # state is per-container. If Modal scaled to >1 container, a POST /agent/start could
    # land on container A while the cockpit's GET /agent/:id/stream lands on container B,
    # which would (a) see no active session and immediately emit session.ended, or
    # (b) re-kick a duplicate loop. Pin to exactly one container so all of a study's
    # traffic shares the same registry. min_containers=1 + max_containers=1 means
    # exactly one warm, long-lived container; @modal.concurrent fans many SSE clients
    # out within it.
    #
    # Out of scope for this pass: externalizing the registry to a Durable Object /
    # Modal Dict so the runtime can scale horizontally. Until then this pin is required.
    max_containers=1,
    # Multi-minute agent loops: a single session can run for up to maxSessionSeconds
    # (default 1800s). Give the web server container ample headroom beyond that.
    timeout=3600,
)
@modal.concurrent(max_inputs=100)  # one warm container fans out many concurrent SSE clients
@modal.web_server(PORT, startup_timeout=120)
def agent_runtime():
    """Launch the Node agent-runtime HTTP/SSE server and let Modal proxy traffic to it.

    web_server semantics: this function must start a process that binds PORT (on the
    external interface — Node's server.listen(port) binds 0.0.0.0 by default) and then
    return. Modal transparently proxies all HTTP, SSE, and WebSocket traffic to it.
    """
    import os

    env = dict(os.environ)
    # Force the Node server to listen on the port Modal proxies, regardless of what the
    # secret carries, so the two can never drift.
    env["AGENT_RUNTIME_PORT"] = str(PORT)

    # Non-blocking: start the server and return; Modal handles the request proxying.
    subprocess.Popen(
        ["node", "/app/src/server.mjs"],
        env=env,
        cwd="/app",
    )
