#!/usr/bin/env python3
"""
Grade a Labmate study against docs/rubric.json.

This is the local implementation behind the `grade_study_against_rubric` MCP tool and the
Stop hook. It makes "done" verifiable WITHOUT a human: it loads the rubric, fetches the
study's ledger state, evaluates each check, and prints pass/fail per required check plus an
overall verdict. Exit code is non-zero if any required check fails.

This is a STARTER. It parses the rubric and lays out the evaluation loop; wire `fetch_state`
to your control plane (apps/web /api/studies/:id) so it grades real data. Until then it runs
in --dry mode and shows which checks would be evaluated.

Usage:
  python scripts/grade_study.py --study study_123 --rubric docs/rubric.json
  python scripts/grade_study.py --study study_123 --dry      # show checks without fetching
"""

import argparse
import json
import os
import sys
import urllib.request


def load_rubric(path):
    with open(path, "r") as f:
        return json.load(f)


def fetch_state(study_id):
    """Fetch the study's ledger state from the control plane.

    Returns a dict the checks can evaluate against (study, data_contract, hypotheses,
    runs, critiques, decisions, feedback, artifacts).
    """
    base = os.environ.get("LABMATE_PUBLIC_URL")
    if not base:
        raise RuntimeError("LABMATE_PUBLIC_URL not set — cannot fetch study state. Use --dry to list checks.")
    url = f"{base}/api/studies/{study_id}"
    # TODO: include auth if your GET route requires it.
    with urllib.request.urlopen(url, timeout=20) as resp:
        return json.loads(resp.read().decode())


def evaluate_check(check, state):
    """Evaluate one rubric check against the fetched state.

    The rubric expresses checks in a small pseudo-DSL (see docs/rubric.json). For the MVP,
    implement them as explicit Python predicates keyed by check id — clearer and safer than
    eval'ing the DSL string. Return (passed: bool, detail: str).
    """
    cid = check["id"]
    # TODO: implement per-check predicates against `state`. Examples:
    #   if cid == "five_experiments":
    #       n = len(state.get("hypotheses", []))
    #       return n >= 5, f"{n} hypotheses"
    #   if cid == "caught_an_issue":
    #       crits = [c for c in state.get("critiques", [])
    #                if c["kind"] in ("leakage", "test_set_tuning")
    #                and c.get("led_to_decision") in ("reject", "rerun")]
    #       return bool(crits), f"{len(crits)} qualifying critiques"
    return None, "not implemented"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--study", required=True)
    ap.add_argument("--rubric", default="docs/rubric.json")
    ap.add_argument("--dry", action="store_true", help="list checks without fetching state")
    args = ap.parse_args()

    rubric = load_rubric(args.rubric)
    print(f"Grading study {args.study} against {rubric['name']} v{rubric['version']}\n")

    state = None
    if not args.dry:
        try:
            state = fetch_state(args.study)
        except Exception as e:
            print(f"Could not fetch state ({e}). Falling back to --dry listing.\n")
            args.dry = True

    total_required = 0
    passed_required = 0
    unimplemented = 0

    for cat in rubric["categories"]:
        print(f"## {cat['title']}")
        for check in cat["checks"]:
            req = check.get("required", False)
            tag = "REQUIRED" if req else "optional"
            if args.dry or state is None:
                print(f"  [ ] ({tag}) {check['id']}: {check['description']}")
                continue
            passed, detail = evaluate_check(check, state)
            if passed is None:
                unimplemented += 1
                print(f"  [?] ({tag}) {check['id']}: NOT IMPLEMENTED — {detail}")
            else:
                mark = "✅" if passed else "❌"
                print(f"  {mark} ({tag}) {check['id']}: {detail}")
                if req:
                    total_required += 1
                    if passed:
                        passed_required += 1
        print()

    if args.dry or state is None:
        print("Dry run — implement fetch_state + evaluate_check to grade real studies.")
        sys.exit(0)

    print(f"Required checks passed: {passed_required}/{total_required}")
    if unimplemented:
        print(f"({unimplemented} checks not yet implemented — finish evaluate_check.)")
    done = total_required > 0 and passed_required == total_required and unimplemented == 0
    print("VERDICT:", "DONE ✅" if done else "NOT DONE ❌")
    sys.exit(0 if done else 1)


if __name__ == "__main__":
    main()
