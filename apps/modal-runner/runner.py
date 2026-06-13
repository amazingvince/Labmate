"""
Labmate Modal runner — the FIXED experiment executor.

Claude does NOT run arbitrary code. It builds an experiment *manifest* (JSON) and posts
it here; this runner trains on a deterministic split and returns metrics + artifacts.
This keeps execution sandboxed (Modal) with no arbitrary data egress.

Deploy:  modal deploy apps/modal-runner/runner.py
After deploy, Modal prints a web URL — put it in .env as MODAL_RUNNER_URL, and set it on
the Worker (`wrangler secret put MODAL_RUNNER_URL` or [vars]).

Manifest shape: see packages/schemas/experiment_manifest.schema.json. The methodology
guardrails are encoded so the runner refuses unsafe manifests:
  * split.seed is required (reproducibility),
  * search.tune_on must never be "test",
  * no banned/leaky column may appear in features.

The returned result the Worker records:
  {
    "status": "completed",
    "metrics": { "recall_at_fpr": ..., "precision": ..., "false_positive_rate": ...,
                 "roc_auc": ..., "pr_auc": ..., "recall": ... },   # regression: rmse, mae, r2
    "params": {...},
    "artifacts": { "confusion_matrix": {...}, "feature_importance": {...} },
    "provenance": { "dataset_hash": "...", "code_hash": "...", "seed": 42 }
  }
"""

import hashlib
import io
import json
import os
import urllib.request

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

# Code hash for provenance: pin the runner source so every run is traceable to this file.
try:
    with open(__file__, "rb") as _f:
        _CODE_HASH = hashlib.sha256(_f.read()).hexdigest()[:12]
except OSError:
    _CODE_HASH = "unknown"


def _validate_manifest(m: dict) -> None:
    """Refuse manifests that violate the protocol — guardrails as code."""
    split = m.get("split", {})
    if "seed" not in split or split.get("seed") is None:
        raise ValueError("Manifest rejected: split.seed is required (reproducibility).")
    search = m.get("search", {})
    if str(search.get("tune_on") or "").strip().lower() == "test":
        # This is exactly the planted critic-catch. The runner won't tune on test (any casing, enabled or not).
        raise ValueError("Manifest rejected: tuning on the test split is not allowed. Use tune_on='validation'.")
    banned = set(m.get("banned_columns", []))
    feats = set(m.get("features", []))
    leaked = banned & feats
    if leaked:
        raise ValueError(f"Manifest rejected: banned/leaky columns present in features: {sorted(leaked)}.")


def _load_dataset(uri: str):
    """Load the CSV the manifest points at and return (DataFrame, dataset_hash).

    Accepts an http(s) URL or a path/key. For an R2 key, set LABMATE_DATASET_BASE to a
    public base URL so the runner can fetch `${LABMATE_DATASET_BASE}/${key}`.
    """
    import pandas as pd

    raw = None
    if uri.startswith("http://") or uri.startswith("https://"):
        with urllib.request.urlopen(uri, timeout=60) as resp:
            raw = resp.read()
    else:
        base = os.environ.get("LABMATE_DATASET_BASE", "").rstrip("/")
        if os.path.exists(uri):
            with open(uri, "rb") as f:
                raw = f.read()
        elif base:
            url = f"{base}/{uri.lstrip('/')}"
            with urllib.request.urlopen(url, timeout=60) as resp:
                raw = resp.read()
        else:
            raise ValueError(f"Cannot resolve dataset_uri '{uri}'. Provide an http(s) URL or set LABMATE_DATASET_BASE.")

    df = pd.read_csv(io.BytesIO(raw))
    return df, hashlib.sha256(raw).hexdigest()[:16]


def _split(df, manifest):
    """Deterministic split BEFORE any feature engineering. Returns (train, val, test)."""
    split = manifest["split"]
    seed = split["seed"]
    ratios = split.get("ratios", [0.7, 0.15, 0.15])
    if split.get("strategy") == "time_based":
        time_col = split.get("time_col")
        ordered = df.sort_values(time_col) if time_col and time_col in df.columns else df
        n = len(ordered)
        a = int(n * ratios[0])
        b = int(n * (ratios[0] + ratios[1]))
        return ordered.iloc[:a], ordered.iloc[a:b], ordered.iloc[b:]
    # stratified
    from sklearn.model_selection import train_test_split

    target = manifest["target"]
    test_size = ratios[1] + ratios[2]
    strat = df[target] if manifest.get("task_type") == "binary_classification" else None
    train, rest = train_test_split(df, test_size=test_size, random_state=seed, stratify=strat)
    rel = ratios[2] / (ratios[1] + ratios[2])
    strat2 = rest[target] if strat is not None else None
    val, test = train_test_split(rest, test_size=rel, random_state=seed, stratify=strat2)
    return train, val, test


def _preprocessor(df, features):
    import pandas as pd
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    num = [c for c in features if pd.api.types.is_numeric_dtype(df[c])]
    cat = [c for c in features if c not in num]
    num_pipe = Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())])
    cat_pipe = Pipeline(
        [("impute", SimpleImputer(strategy="most_frequent")), ("oh", OneHotEncoder(handle_unknown="ignore"))]
    )
    return ColumnTransformer([("num", num_pipe, num), ("cat", cat_pipe, cat)]), num, cat


def _build_estimator(family, seed, params):
    from sklearn.dummy import DummyClassifier
    from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
    from sklearn.linear_model import LinearRegression, LogisticRegression

    params = dict(params or {})
    if family == "dummy":
        return DummyClassifier(strategy="prior")
    if family == "logistic_regression":
        return LogisticRegression(max_iter=1000, **params)
    if family == "linear_regression":
        return LinearRegression(**params)
    if family == "random_forest":
        return RandomForestClassifier(random_state=seed, n_jobs=-1, **params)
    if family in ("hist_gradient_boosting", "xgboost", "lightgbm"):
        # xgboost/lightgbm aren't in the default image; HGB is the safe stand-in.
        return HistGradientBoostingClassifier(random_state=seed, **params)
    raise ValueError(f"Unsupported model family: {family}")


def _recall_at_fpr(y_true, scores, max_fpr, threshold=None):
    """Pick the threshold on the provided scores (validation) that maximizes recall while
    keeping FPR <= max_fpr; return (metrics, chosen_threshold). If threshold is given, use it."""
    import numpy as np
    from sklearn.metrics import confusion_matrix

    y_true = np.asarray(y_true).astype(int)
    scores = np.asarray(scores, dtype=float)
    if threshold is None:
        best_t, best_recall = 0.5, -1.0
        for t in np.unique(np.round(scores, 4)):
            pred = (scores >= t).astype(int)
            tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
            fpr = fp / (fp + tn) if (fp + tn) else 0.0
            recall = tp / (tp + fn) if (tp + fn) else 0.0
            if fpr <= max_fpr and recall > best_recall:
                best_recall, best_t = recall, float(t)
        threshold = best_t
    pred = (scores >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    cm = {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp), "threshold": float(threshold)}
    return {"recall": recall, "precision": precision, "false_positive_rate": fpr}, float(threshold), cm


@app.function(image=image, timeout=900)
def train(manifest: dict) -> dict:
    """Train one experiment from a manifest and return metrics + artifacts + provenance."""
    import numpy as np
    from sklearn.metrics import average_precision_score, mean_absolute_error, mean_squared_error, r2_score, roc_auc_score

    _validate_manifest(manifest)

    target = manifest["target"]
    features = list(manifest.get("features", []))
    seed = manifest["split"]["seed"]
    task = manifest.get("task_type", "binary_classification")
    tags = manifest.get("tags", [])
    family = manifest.get("model", {}).get("family", "logistic_regression")
    params = manifest.get("model", {}).get("params", {})
    max_fpr = manifest.get("metric", {}).get("max_fpr", 0.20)

    df, dataset_hash = _load_dataset(manifest["dataset_uri"])
    train_df, val_df, test_df = _split(df, manifest)
    pre, num, cat = _preprocessor(df, features)

    from sklearn.pipeline import Pipeline

    artifacts = {}

    if task == "regression":
        est = _build_estimator(family if family != "dummy" else "linear_regression", seed, params)
        pipe = Pipeline([("pre", pre), ("model", est)])
        pipe.fit(train_df[features], train_df[target])
        pred = pipe.predict(test_df[features])
        y = test_df[target].to_numpy(dtype=float)
        rmse = float(np.sqrt(mean_squared_error(y, pred)))
        metrics = {"rmse": rmse, "mae": float(mean_absolute_error(y, pred)), "r2": float(r2_score(y, pred))}
    else:
        est = _build_estimator(family, seed, params)
        pipe = Pipeline([("pre", pre), ("model", est)])
        pipe.fit(train_df[features], train_df[target].astype(int))

        def scores_for(frame):
            # All supported families expose predict_proba. A decision_function-only
            # estimator would need calibration (e.g. CalibratedClassifierCV) so a
            # validation-chosen threshold transfers to test on a consistent scale.
            if not hasattr(pipe, "predict_proba"):
                raise ValueError(
                    f"Model family '{family}' has no predict_proba; calibrate it before adding it to this runner."
                )
            return pipe.predict_proba(frame[features])[:, 1]

        # threshold chosen on VALIDATION, evaluated once on TEST
        val_scores = scores_for(val_df)
        _, threshold, _ = _recall_at_fpr(val_df[target].astype(int), val_scores, max_fpr, threshold=None)
        test_scores = scores_for(test_df)
        at_fpr, threshold, cm = _recall_at_fpr(test_df[target].astype(int), test_scores, max_fpr, threshold=threshold)
        y = test_df[target].to_numpy(dtype=int)
        metrics = {
            "recall_at_fpr": at_fpr["recall"],
            "recall": at_fpr["recall"],
            "precision": at_fpr["precision"],
            "false_positive_rate": at_fpr["false_positive_rate"],
        }
        try:
            metrics["roc_auc"] = float(roc_auc_score(y, test_scores))
            metrics["pr_auc"] = float(average_precision_score(y, test_scores))
        except ValueError:
            # single-class test split → AUC undefined; omit rather than report a misleading 0.0
            pass
        artifacts["confusion_matrix"] = {"kind": "confusion_matrix", "data": cm}

    metrics = {k: round(float(v), 6) for k, v in metrics.items()}
    return {
        "status": "completed",
        "metrics": metrics,
        "params": {"family": family, "tags": tags, **(params or {})},
        "artifacts": artifacts,
        "provenance": {"dataset_hash": dataset_hash, "code_hash": _CODE_HASH, "seed": seed},
    }


@app.function(image=image)
@modal.fastapi_endpoint(method="POST")
def launch(manifest: dict):
    """HTTP entrypoint the Cloudflare Worker calls from /api/experiments/launch."""
    try:
        _validate_manifest(manifest)
    except ValueError as e:
        return {"status": "rejected", "reason": str(e)}
    try:
        return train.remote(manifest)
    except Exception as e:  # surface failures as a recordable, non-crashing result
        return {"status": "failed", "reason": str(e), "provenance": {"code_hash": _CODE_HASH, "seed": manifest.get("split", {}).get("seed")}}


if __name__ == "__main__":
    # Local smoke test (needs pandas/scikit-learn): python runner.py examples/sla_tickets/data.csv
    import sys

    csv = sys.argv[1] if len(sys.argv) > 1 else "examples/sla_tickets/data.csv"
    demo = {
        "study_id": "study_local",
        "hypothesis_id": "hyp_local",
        "dataset_uri": csv,
        "target": "breached_sla",
        "task_type": "binary_classification",
        "split": {"strategy": "time_based", "time_col": "created_at", "ratios": [0.7, 0.15, 0.15], "seed": 42},
        "features": [
            "priority", "customer_tier", "channel", "product_area", "region",
            "reporter_history_count", "queue_depth_at_creation", "is_reopen",
            "description_length", "business_hours_flag",
        ],
        "banned_columns": ["resolved_at", "time_to_resolution", "closed_status", "agent_notes_final"],
        "model": {"family": "logistic_regression"},
        "metric": {"primary": "recall_at_fpr", "max_fpr": 0.20},
        "tags": ["baseline"],
    }
    print(json.dumps(train.local(demo), indent=2))
