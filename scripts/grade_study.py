#!/usr/bin/env python3
"""
Grade a Labmate study against docs/rubric.json.

This is the CLI behind the `grade_study_against_rubric` MCP tool and the Stop hook. It
makes "done" verifiable WITHOUT a human: it calls the control plane's POST /api/grade
(the single source of truth for the rubric evaluation), then renders pass/fail per check
plus an overall verdict. Exit code is non-zero if any required check fails.

Usage:
  python scripts/grade_study.py --study study_123
  python scripts/grade_study.py --study study_123 --rubric docs/rubric.json
  python scripts/grade_study.py --study study_123 --dry      # list checks without grading
"""

import argparse
import json
import os
import sys
import urllib.request


def load_rubric(path):
    with open(path, "r") as f:
        return json.load(f)


def load_env():
    """Merge process env with the repo .env (supports both KEY=val and KEY: val)."""
    env = dict(os.environ)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, ".env")
    if os.path.exists(path):
        with open(path, "r") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                for sep in (":", "="):
                    if sep in s:
                        k, v = s.split(sep, 1)
                        k, v = k.strip(), v.strip()
                        if not env.get(k):
                            env[k] = v
                        break
    return env


def grade_via_api(study_id, env):
    base = (env.get("LABMATE_PUBLIC_URL") or "http://localhost:8787").rstrip("/")
    token = env.get("LABMATE_INTERNAL_TOKEN", "")
    req = urllib.request.Request(
        f"{base}/api/grade",
        data=json.dumps({"study_id": study_id}).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--study", required=True)
    ap.add_argument("--rubric", default="docs/rubric.json")
    ap.add_argument("--dry", action="store_true", help="list checks without grading")
    args = ap.parse_args()

    rubric = load_rubric(args.rubric)
    print(f"Grading study {args.study} against {rubric['name']} v{rubric['version']}\n")

    if args.dry:
        for cat in rubric["categories"]:
            print(f"## {cat['title']}")
            for check in cat["checks"]:
                tag = "REQUIRED" if check.get("required") else "optional"
                print(f"  [ ] ({tag}) {check['id']}: {check['description']}")
            print()
        print("Dry run — start the Worker and drop --dry to grade real studies.")
        sys.exit(0)

    env = load_env()
    try:
        result = grade_via_api(args.study, env)
    except Exception as e:  # noqa: BLE001
        print(f"Could not reach POST /api/grade ({e}). Is the Worker running and LABMATE_PUBLIC_URL set?")
        print("Tip: run with --dry to list the checks without grading.")
        sys.exit(2)

    by_cat = {}
    for c in result.get("checks", []):
        by_cat.setdefault(c.get("category", "other"), []).append(c)
    titles = {cat["id"]: cat["title"] for cat in rubric["categories"]}
    for cat_id, checks in by_cat.items():
        print(f"## {titles.get(cat_id, cat_id)}")
        for c in checks:
            tag = "REQUIRED" if c.get("required") else "optional"
            mark = "✅" if c.get("passed") else "❌"
            print(f"  {mark} ({tag}) {c['id']}: {c.get('detail', '')}")
        print()

    print(f"Required checks passed: {result.get('passed_required')}/{result.get('total_required')}")
    done = result.get("verdict") == "done"
    print("VERDICT:", "DONE ✅" if done else "NOT DONE ❌")
    sys.exit(0 if done else 1)


if __name__ == "__main__":
    main()
