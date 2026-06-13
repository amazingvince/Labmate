#!/usr/bin/env python3
"""
UI conformance check (fast, deterministic, no browser).

Confirms frontend/index.html honors the contract's structural rules: it reads
/api/state, uses exactly the five endpoints, renders feed text safely, and wires a
checkpoint modal with approve/reject. These are the parts that can be checked
statically; the *visual* rubric items (best-highlight, leak flag, all status states,
autoscroll) need eyes against the mock and live in RUBRIC_ui.md.

Exit 0 = pass, 1 = fail (gate.sh maps a fail to the Stop-hook block code 2).
"""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[1]
html = (root / "frontend" / "index.html").read_text()
problems = []

for ep in ["/api/state", "/api/run", "/api/steer", "/api/checkpoint", "/api/stop"]:
    if ep not in html:
        problems.append(f"UI never references {ep} (it must read /api/state and use all four commands)")

if "setInterval" not in html and "setTimeout" not in html:
    problems.append("no polling loop found (expected setInterval/setTimeout on /api/state)")

if not ("escapeHtml" in html or "textContent" in html or "&lt;" in html):
    problems.append("feed text is not rendered safely (use textContent or HTML-escape)")

if not ("approve" in html and "reject" in html):
    problems.append("checkpoint decisions approve/reject are not both wired")

if not re.search(r"modal|overlay|dialog", html, re.I):
    problems.append("no checkpoint modal/overlay element found")

if problems:
    print("UI CONFORMANCE CHECK: FAIL")
    for p in problems:
        print("  -", p)
    sys.exit(1)

print("UI CONFORMANCE CHECK: PASS")
sys.exit(0)
