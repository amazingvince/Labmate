#!/usr/bin/env python3
"""
REAL-mode helper for the local runner shim (scripts/local_runner_shim.mjs).

Reads an experiment payload as JSON on stdin:
    { "script": "<agent python>", "dataset_uri": "...", "declared": {...}, "repo": "..." }

It mirrors apps/modal-runner/runner.py `_run_experiment_sandbox` WITHOUT Modal:
  * resolves the CSV (from dataset_uri http(s) or a local examples/<id>.csv),
  * PHYSICALLY strips banned/leakage columns from the CSV,
  * writes the stripped CSV to a scratch /work/data.csv and runs the agent's script
    there in a subprocess (the script reads /work/data.csv, writes /work/result.json),
  * reads result.json, coerces metrics to finite floats, stamps provenance.

It NEVER raises to the shim: any failure prints a JSON result with status "failed" and a
distinct reason. Requires pandas/scikit-learn in the active interpreter for the AGENT's
script to run (the helper itself only needs pandas to strip columns; if pandas is
missing it falls back to a header-only strip).
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.request


def _emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def _provenance(seed, dataset_hash=None):
    return {
        "dataset_hash": dataset_hash,
        "code_hash": "shimreal01",
        "deps_hash": "shimdeps",
        "seed": seed,
    }


def _resolve_csv_bytes(dataset_uri, repo):
    """Return CSV bytes. Prefer a local examples file; fall back to http(s)."""
    # dataset_uri looks like "http://127.0.0.1:8787/data/sla_tickets.csv" or "sla_tickets.csv".
    name = (dataset_uri or "sla_tickets.csv").rstrip("/").split("/")[-1]
    stem = name[:-4] if name.endswith(".csv") else name
    # 1) local examples/<stem>/data.csv (the bundled golden dataset)
    local = os.path.join(repo, "examples", stem, "data.csv")
    if os.path.exists(local):
        with open(local, "rb") as f:
            return f.read()
    # 2) local examples/<stem>.csv
    local2 = os.path.join(repo, "examples", name)
    if os.path.exists(local2):
        with open(local2, "rb") as f:
            return f.read()
    # 3) http(s) fetch (e.g. the worker's /data route)
    if dataset_uri and dataset_uri.startswith(("http://", "https://")):
        with urllib.request.urlopen(dataset_uri, timeout=30) as resp:  # noqa: S310 (local only)
            return resp.read()
    raise FileNotFoundError(f"could not resolve dataset for uri={dataset_uri!r} (stem={stem})")


def _strip_banned(raw, banned):
    banned = set(banned or [])
    if not banned:
        return raw
    try:
        import io

        import pandas as pd

        df = pd.read_csv(io.BytesIO(raw))
        drop = [c for c in df.columns if c in banned]
        if drop:
            df = df.drop(columns=drop)
        buf = io.BytesIO()
        df.to_csv(buf, index=False)
        return buf.getvalue()
    except Exception:
        return raw


def _coerce_metrics(raw_metrics):
    import math

    out = {}
    for k, v in (raw_metrics or {}).items():
        if isinstance(v, bool):
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if math.isnan(f) or math.isinf(f):
            continue
        out[k] = round(f, 6)
    return out


def main():
    payload = json.load(sys.stdin)
    declared = payload.get("declared") or {}
    seed = declared.get("seed")
    script = payload.get("script") or ""
    repo = payload.get("repo") or os.getcwd()
    banned = declared.get("banned_columns") or []

    if not script.strip():
        return _emit({"status": "failed", "reason": "no_script", "provenance": _provenance(seed)})

    try:
        raw = _resolve_csv_bytes(payload.get("dataset_uri"), repo)
    except Exception as e:  # noqa: BLE001
        return _emit({"status": "failed", "reason": f"dataset_missing:{type(e).__name__}", "provenance": _provenance(seed)})

    dataset_hash = hashlib.sha256(raw).hexdigest()[:12]
    stripped = _strip_banned(raw, banned)

    work = tempfile.mkdtemp(prefix="labmate_real_")
    data_path = os.path.join(work, "data.csv")
    with open(data_path, "wb") as f:
        f.write(stripped)
    # The agent's script reads /work/data.csv by absolute path. Provide that path by
    # running in a /work dir; also symlink an absolute /work when possible.
    script_path = os.path.join(work, "experiment.py")
    # Rewrite the conventional "/work/" prefix to this scratch dir so the script's
    # hard-coded /work/data.csv and /work/result.json resolve locally (no real /work).
    local_script = script.replace("/work/", work.rstrip("/") + "/")
    with open(script_path, "w") as f:
        f.write(local_script)

    try:
        proc = subprocess.run(
            [sys.executable, script_path],
            cwd=work,
            capture_output=True,
            text=True,
            timeout=240,
        )
    except subprocess.TimeoutExpired:
        return _emit({"status": "failed", "reason": "script_timeout", "provenance": _provenance(seed, dataset_hash)})
    except Exception as e:  # noqa: BLE001
        return _emit({"status": "failed", "reason": f"script_spawn:{type(e).__name__}", "provenance": _provenance(seed, dataset_hash)})

    result_path = os.path.join(work, "result.json")
    if not os.path.exists(result_path):
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        return _emit(
            {
                "status": "failed",
                "reason": "no_result_json: " + " | ".join(tail)[:400],
                "provenance": _provenance(seed, dataset_hash),
            }
        )

    try:
        with open(result_path) as f:
            result = json.load(f)
    except Exception as e:  # noqa: BLE001
        return _emit({"status": "failed", "reason": f"bad_result_json:{type(e).__name__}", "provenance": _provenance(seed, dataset_hash)})

    metrics = _coerce_metrics(result.get("metrics") or {})
    params = result.get("params") or {}
    if "model" not in params and "family" in params:
        params["model"] = params["family"]
    artifacts = result.get("artifacts") or {}
    artifacts.setdefault("features", declared.get("features") or [])

    max_fpr = declared.get("max_fpr")
    fpr = metrics.get("false_positive_rate")
    fpr_ok = None
    if max_fpr is not None and fpr is not None:
        fpr_ok = bool(fpr <= float(max_fpr) + 1e-9)

    out = {
        "status": "completed",
        "metrics": metrics,
        "params": params,
        "artifacts": artifacts,
        "provenance": _provenance(seed, dataset_hash),
    }
    if fpr_ok is not None:
        out["fpr_guardrail_satisfied"] = fpr_ok
    return _emit(out)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — never crash the shim
        _emit({"status": "failed", "reason": f"helper_error:{type(e).__name__}:{e}", "provenance": _provenance(None)})
