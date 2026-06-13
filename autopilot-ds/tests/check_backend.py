#!/usr/bin/env python3
"""
Backend contract-surface check (fast, deterministic, no API key, no server).

Confirms backend/app.py + backend/agent_config.py still expose the contract:
the five endpoints, the State shape, the status vocabulary, the input guards, and
the two custom tools. This is the backend stream's automated gate — it does NOT
prove live behavior (that's tests/test_contract_e2e.py), it prevents the agent from
"finishing" with a structurally broken contract surface.

Exit 0 = pass, 1 = fail (gate.sh maps a fail to the Stop-hook block code 2).
"""
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parents[1]
app = (root / "backend" / "app.py").read_text()
cfg = (root / "backend" / "agent_config.py").read_text()
problems = []

for ep in ["/api/run", "/api/state", "/api/steer", "/api/checkpoint", "/api/stop"]:
    if ep not in app:
        problems.append(f"backend/app.py never references endpoint {ep}")

for key in ['"status"', '"session_id"', '"feed"', '"experiments"', '"checkpoint"']:
    if key not in app:
        problems.append(f"/api/state State object missing key {key}")

for st in ["idle", "running", "waiting", "done", "error", "stopped"]:
    if f'"{st}"' not in app:
        problems.append(f"status value '{st}' not referenced in app.py")

for code in ["409", "400", "404"]:
    if code not in app:
        problems.append(f"input guard for HTTP {code} not present (see contract §2.1)")

for tool in ["log_experiment", "request_approval"]:
    if tool not in cfg:
        problems.append(f"custom tool '{tool}' not declared in agent_config.py")

for sym in ["MODEL", "CUSTOM_TOOLS", "SYSTEM_PROMPT", "KICKOFF_TASK"]:
    if sym not in cfg:
        problems.append(f"agent_config.py missing required symbol {sym}")

if problems:
    print("BACKEND CONTRACT-SURFACE CHECK: FAIL")
    for p in problems:
        print("  -", p)
    sys.exit(1)

print("BACKEND CONTRACT-SURFACE CHECK: PASS")
sys.exit(0)
