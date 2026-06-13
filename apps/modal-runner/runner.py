"""
Labmate Modal runner — the FIXED experiment executor.

Claude does NOT run arbitrary code. It builds an experiment *manifest* (JSON) and posts
it here; this runner trains on a deterministic split and returns metrics + artifacts.
This keeps execution sandboxed (Modal) with no arbitrary data egress.

Deploy:  modal deploy apps/modal-runner/runner.py
After deploy, Modal prints a web URL — put it in .env as MODAL_RUNNER_URL.

Manifest shape (see packages/schemas/experiment_manifest.schema.json):
{
  "study_id": "...",
  "dataset_uri": "...",          # where the runner pulls the CSV (R2 / public)
  "target": "breached_sla",
  "task_type": "binary_classification",
  "split": {"strategy": "time_based", "time_col": "created_at",
            "ratios": [0.70, 0.15, 0.15], "seed": 42},
  "features": ["priority", "customer_tier", ...],   # MUST exclude banned/leaky cols
  "banned_columns": ["resolved_at", "time_to_resolution", "closed_status"],
  "model": {"family": "random_forest", "params": {...}},
  "search": {"enabled": true, "max_trials": 20, "timeout_seconds": 600,
             "tune_on": "validation"},             # NEVER "test"
  "metric": {"primary": "recall_at_fpr", "max_fpr": 0.20},
  "tags": ["baseline"]                              # optional
}

This is a STARTER: the Modal app + endpoint + the train() contract are defined, with
TODOs for the sklearn/optuna body. The methodology guardrails (split first, tune on
validation, baseline) are encoded so the runner refuses unsafe manifests.
"""

import modal

app = modal.App("labmate-runner")

image = (
    modal.Image.debian_slim()
    .pip_install(
        "pandas",
        "scikit-learn",
        "optuna",
        "numpy",
        "fastapi[standard]",
        # Add "xgboost", "lightgbm" only if you confirmed setup is smooth (see BUILD_PLAN risks).
    )
)


def _validate_manifest(m: dict) -> None:
    """Refuse manifests that violate the protocol — guardrails as code."""
    split = m.get("split", {})
    if "seed" not in split:
        raise ValueError("Manifest rejected: split.seed is required (reproducibility).")
    search = m.get("search", {})
    if search.get("enabled") and search.get("tune_on") == "test":
        # This is exactly the planted critic-catch. The runner won't tune on test.
        raise ValueError("Manifest rejected: tuning on the test split is not allowed. Use tune_on='validation'.")
    banned = set(m.get("banned_columns", []))
    feats = set(m.get("features", []))
    leaked = banned & feats
    if leaked:
        raise ValueError(f"Manifest rejected: banned/leaky columns present in features: {sorted(leaked)}.")


@app.function(image=image, timeout=900)
def train(manifest: dict) -> dict:
    """
    Train one experiment from a manifest and return a result dict:
      {
        "status": "completed",
        "metrics": {"recall_at_fpr": ..., "precision": ..., "roc_auc": ..., "pr_auc": ...},
        "params": {...},
        "artifacts": {"confusion_matrix": "<uri-or-b64>", "feature_importance": "..."},
        "provenance": {"dataset_hash": "...", "code_hash": "...", "seed": 42}
      }
    """
    import hashlib, json

    _validate_manifest(manifest)

    # --- Load + split (deterministic, BEFORE feature engineering) -------------
    # TODO: pull dataset from manifest["dataset_uri"], compute dataset_hash,
    # build the time-based (or stratified) split with the fixed seed.
    #
    # --- Baseline OR model -----------------------------------------------------
    # TODO: if "baseline" in manifest.get("tags", []): fit DummyClassifier + LogisticRegression.
    #       else: fit the requested model family; if search.enabled, run Optuna (TPE,
    #       capped trials, prune) tuning ON VALIDATION ONLY (see optuna-search skill).
    #
    # --- Evaluate --------------------------------------------------------------
    # TODO: compute primary metric (recall at FPR<=max_fpr) on validation to pick the
    #       threshold, then evaluate ONCE on test. Build confusion matrix + feature importance.
    #
    # --- Provenance ------------------------------------------------------------
    code_hash = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:12]

    return {
        "status": "todo",
        "message": "Implement train(): split-first, baseline-or-model, validation-tuned, test-once.",
        "params": manifest.get("model", {}).get("params", {}),
        "provenance": {"dataset_hash": None, "code_hash": code_hash, "seed": manifest.get("split", {}).get("seed")},
    }


@app.function(image=image)
@modal.fastapi_endpoint(method="POST")
def launch(manifest: dict):
    """
    HTTP entrypoint the Cloudflare Worker calls from /api/experiments/launch.
    Validates, runs train(), returns the result JSON.
    """
    try:
        _validate_manifest(manifest)
    except ValueError as e:
        return {"status": "rejected", "reason": str(e)}
    result = train.remote(manifest)
    return result
