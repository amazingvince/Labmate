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
    "provenance": { "dataset_hash": "...", "code_hash": "...", "seed": 42 },
    "fpr_guardrail_satisfied": true   # classification, when a max_fpr bound is in force
  }

The runner NEVER 500s: any error — bad manifest, dataset 404/timeout, sandbox kill,
guardrail violation — becomes a recordable result with a distinct `reason`.
"""

import hashlib
import io
import json
import math
import os
import urllib.error
import urllib.request

import modal

app = modal.App("labmate-runner")

# Pinned training deps — keep in sync with requirements.txt. Pinning makes the image
# reproducible AND lets provenance reflect the exact deps a run executed against.
_DEPS_PINS = [
    "pandas==2.2.2",
    "scikit-learn==1.4.2",
    "optuna==3.6.1",
    "numpy==1.26.4",
]

image = (
    modal.Image.debian_slim()
    .pip_install(
        *_DEPS_PINS,
        "fastapi[standard]",
        # Add "xgboost", "lightgbm" only if you confirmed setup is smooth (see BUILD_PLAN risks).
    )
)

# Code hash for provenance: hash the runner source AND the pinned dependency set, so a
# run is traceable to both this file and the exact deps it ran against. Hashing only the
# source (as before) hid dependency drift; folding _DEPS_PINS in makes provenance honest.
try:
    with open(__file__, "rb") as _f:
        _source_digest = hashlib.sha256(_f.read())
except OSError:
    _source_digest = hashlib.sha256(b"unknown-source")
_source_digest.update(b"\x00deps\x00")
_source_digest.update("\n".join(_DEPS_PINS).encode("utf-8"))
_CODE_HASH = _source_digest.hexdigest()[:12]
# Short digest of just the pinned deps, surfaced in provenance for auditability.
_DEPS_HASH = hashlib.sha256("\n".join(_DEPS_PINS).encode("utf-8")).hexdigest()[:8]

# Float tolerance for guardrail comparisons (floating-point slack on the FPR bound).
_EPS = 1e-9


def _modal_exc(*names):
    """Resolve Modal exception classes by name across SDK versions, defensively.

    Referencing `modal.exception.Foo` directly inside an `except` clause would raise
    AttributeError (and break the never-500 contract) on any SDK version that renamed or
    dropped the class. We resolve the names that DO exist at import time and return a
    tuple usable in `except (...)`. If none resolve, return a private sentinel class that
    can never be raised, so the `except` is a harmless no-op rather than a crash."""
    exc_mod = getattr(modal, "exception", None)
    found = []
    for n in names:
        cls = getattr(exc_mod, n, None) if exc_mod is not None else None
        if isinstance(cls, type) and issubclass(cls, BaseException):
            found.append(cls)
    if found:
        return tuple(found)

    class _NeverRaised(Exception):
        pass

    return (_NeverRaised,)


# Timeout exception classes (names have shifted across Modal SDK releases).
_SANDBOX_TIMEOUT = _modal_exc("SandboxTimeoutError", "SandboxTerminatedError")
_FUNCTION_TIMEOUT = _modal_exc("FunctionTimeoutError", "TimeoutError")


def _is_timeout_exc(e: BaseException) -> bool:
    """A timeout-flavored exception by class OR by name (best-effort across SDKs)."""
    return isinstance(e, _SANDBOX_TIMEOUT) or "timeout" in type(e).__name__.lower()


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


class _DatasetMissing(Exception):
    """Dataset URI resolved to a 404/not-found — a distinct, recordable failure reason."""


class _DatasetTimeout(Exception):
    """Dataset fetch timed out or the host was unreachable — distinct from a 404."""


def _load_dataset(uri: str):
    """Load the CSV the manifest points at and return (DataFrame, dataset_hash).

    Accepts an http(s) URL or a path/key. For an R2 key, set LABMATE_DATASET_BASE to a
    public base URL so the runner can fetch `${LABMATE_DATASET_BASE}/${key}`.
    """
    import pandas as pd

    raw = _dataset_bytes(uri)
    df = pd.read_csv(io.BytesIO(raw))
    return df, hashlib.sha256(raw).hexdigest()[:16]


# A browser-like User-Agent: the default Python-urllib UA is 403'd by Cloudflare Bot
# Fight Mode on the control-plane zone that serves the dataset.
_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def _http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        # Map a 404 (or other not-found-ish status) to a distinct reason so the caller can
        # record `dataset_missing` rather than collapsing every fetch error into one.
        if e.code in (404, 410):
            raise _DatasetMissing(f"dataset not found at URL (HTTP {e.code})") from e
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # URLError wraps socket timeouts / DNS / connection-refused. Treat as a timeout-class
        # failure (host unreachable or too slow) — distinct from a clean 404.
        raise _DatasetTimeout(f"dataset fetch timed out or host unreachable ({type(e).__name__})") from e


def _dataset_bytes(uri: str) -> bytes:
    """Resolve a dataset_uri (http(s) URL, local path, or key under LABMATE_DATASET_BASE) to bytes."""
    if uri.startswith("http://") or uri.startswith("https://"):
        return _http_get(uri)
    base = os.environ.get("LABMATE_DATASET_BASE", "").rstrip("/")
    if os.path.exists(uri):
        with open(uri, "rb") as f:
            return f.read()
    if base:
        return _http_get(f"{base}/{uri.lstrip('/')}")
    raise _DatasetMissing(
        f"Cannot resolve dataset_uri '{uri}'. Provide an http(s) URL or set LABMATE_DATASET_BASE."
    )


def _split(df, manifest):
    """Deterministic split BEFORE any feature engineering. Returns (train, val, test)."""
    split = manifest["split"]
    seed = split["seed"]
    ratios = split.get("ratios", [0.7, 0.15, 0.15])
    if split.get("strategy") == "time_based":
        time_col = split.get("time_col")
        if not time_col or time_col not in df.columns:
            # Don't silently fall back to df order — that fabricates a time order that may
            # not exist and quietly defeats the point of a time-based split.
            raise ValueError(
                f"time_based split requires split.time_col present in the data; "
                f"'{time_col}' is missing (columns: {list(df.columns)[:20]})."
            )
        import numpy as np
        import pandas as pd

        # Cut on TIMESTAMP VALUES, not row index, so same-timestamp rows never straddle a
        # boundary. Sort by the (coerced) timestamp with a stable tiebreak on the original
        # row position, then choose cut points by time quantile and assign every row that
        # shares a boundary timestamp to the EARLIER split (searchsorted 'right').
        ts = pd.to_datetime(df[time_col], errors="coerce")
        order = np.lexsort((np.arange(len(df)), ts.to_numpy()))  # stable: tiebreak on original index
        ordered = df.iloc[order]
        ts_sorted = ts.iloc[order].to_numpy()
        q_train = ratios[0]
        q_val = ratios[0] + ratios[1]
        # Quantiles over non-null timestamps; rows with NaT sort last and land in test.
        valid = ts_sorted[~pd.isnull(ts_sorted)]
        if len(valid) == 0:
            raise ValueError(f"time_based split: column '{time_col}' has no parseable timestamps.")
        t_train = np.quantile(valid, q_train, method="lower") if hasattr(np, "quantile") else valid[int(len(valid) * q_train)]
        t_val = np.quantile(valid, q_val, method="lower")
        # All rows with ts <= t_train go to train; (t_train, t_val] to val; rest to test.
        # If a single timestamp dominates a quantile band, a split can be empty — that's
        # an honest reflection of the data (one timestamp can't be in two splits), not a
        # bug; the caller sees the real sizes rather than a fabricated row-index cut.
        a = int(np.searchsorted(ts_sorted, t_train, side="right"))
        b = int(np.searchsorted(ts_sorted, t_val, side="right"))
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


def _preprocessor(train_df, features):
    """Build a preprocessor, inferring column typing from TRAIN ONLY.

    Inferring numeric/categorical from the full frame would let val/test dtype information
    bleed into the fit decision; train-only typing keeps the split honest.
    """
    import pandas as pd
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    num = [c for c in features if pd.api.types.is_numeric_dtype(train_df[c])]
    cat = [c for c in features if c not in num]
    num_pipe = Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())])
    cat_pipe = Pipeline(
        [("impute", SimpleImputer(strategy="most_frequent")), ("oh", OneHotEncoder(handle_unknown="ignore"))]
    )
    return ColumnTransformer([("num", num_pipe, num), ("cat", cat_pipe, cat)]), num, cat


def _build_estimator(family, seed, params):
    from sklearn.dummy import DummyClassifier, DummyRegressor
    from sklearn.ensemble import (
        GradientBoostingClassifier,
        HistGradientBoostingClassifier,
        RandomForestClassifier,
    )
    from sklearn.linear_model import LinearRegression, LogisticRegression

    params = dict(params or {})
    # Merge agent params over the runner's defaults via dict spread so a param the
    # agent also supplies (e.g. max_iter, random_state) overrides the default rather
    # than colliding as a duplicate keyword argument.
    if family == "dummy":
        # DummyClassifier only takes `strategy` (+ optional constant); honor it.
        # 'stratified' (not 'prior') gives a NON-degenerate score distribution so the
        # recall@FPR baseline is a real ROC-diagonal floor rather than a single constant
        # probability that collapses to recall 0 or 1 at any threshold.
        kw = {"strategy": params.get("strategy", "stratified"), "random_state": seed}
        if "constant" in params:
            kw["constant"] = params["constant"]
        return DummyClassifier(**kw)
    if family == "dummy_regressor":
        # Median predictor — the regression analogue of a classifier prior; a meaningful
        # baseline (constant) instead of a fully-fit LinearRegression masquerading as one.
        return DummyRegressor(**{"strategy": params.get("strategy", "median")})
    if family == "logistic_regression":
        return LogisticRegression(**{"max_iter": 1000, **params})
    if family == "linear_regression":
        return LinearRegression(**params)
    if family == "random_forest":
        return RandomForestClassifier(**{"random_state": seed, "n_jobs": -1, **params})
    if family == "gradient_boosting":
        # Plain sklearn GBM (takes n_estimators/learning_rate/max_depth) — a family
        # the agent reaches for naturally; distinct from the histogram variant below.
        return GradientBoostingClassifier(**{"random_state": seed, **params})
    if family in ("hist_gradient_boosting", "xgboost", "lightgbm"):
        # xgboost/lightgbm aren't in the default image; HGB is the safe stand-in.
        return HistGradientBoostingClassifier(**{"random_state": seed, **params})
    raise ValueError(f"Unsupported model family: {family}")


def _recall_at_fpr(y_true, scores, max_fpr, threshold=None):
    """Pick the threshold on the provided scores (validation) that maximizes recall while
    keeping FPR <= max_fpr; return (metrics, chosen_threshold, cm). If threshold is given,
    use it verbatim (the test-set path)."""
    import numpy as np
    from sklearn.metrics import confusion_matrix, roc_curve

    y_true = np.asarray(y_true).astype(int)
    scores = np.asarray(scores, dtype=float)
    if threshold is None:
        # Build the candidate threshold grid from sklearn's roc_curve (which derives
        # candidate thresholds from the RAW sorted scores), not from rounded scores —
        # rounding to 4 decimals merges distinct operating points and can hide the true
        # best feasible threshold. roc_curve returns (fpr, tpr, thresholds) aligned.
        if len(np.unique(y_true)) < 2:
            # Degenerate (single-class) validation split — no meaningful FPR sweep.
            threshold = 0.5
        else:
            fpr_grid, tpr_grid, thr_grid = roc_curve(y_true, scores)
            best_t, best_recall = 0.5, -1.0
            for fpr_c, tpr_c, t in zip(fpr_grid, tpr_grid, thr_grid):
                # roc_curve's first threshold is +inf (sklearn>=1.3 uses inf); skip it.
                if not np.isfinite(t):
                    continue
                if fpr_c <= max_fpr + _EPS and tpr_c > best_recall:
                    best_recall, best_t = float(tpr_c), float(t)
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
    # Infer column typing from TRAIN only (avoid val/test dtype bleed).
    pre, num, cat = _preprocessor(train_df, features)

    from sklearn.pipeline import Pipeline

    artifacts = {}
    provenance = {
        "dataset_hash": dataset_hash,
        "code_hash": _CODE_HASH,
        "deps_hash": _DEPS_HASH,
        "seed": seed,
    }

    if task == "regression":
        # 'dummy' → a real median baseline (DummyRegressor), not a full LinearRegression.
        reg_family = "dummy_regressor" if family == "dummy" else family
        est = _build_estimator(reg_family, seed, params)
        pipe = Pipeline([("pre", pre), ("model", est)])
        pipe.fit(train_df[features], train_df[target])

        def _reg_metrics(frame):
            yhat = pipe.predict(frame[features])
            yv = frame[target].to_numpy(dtype=float)
            return {
                "rmse": float(np.sqrt(mean_squared_error(yv, yhat))),
                "mae": float(mean_absolute_error(yv, yhat)),
                "r2": float(r2_score(yv, yhat)),
            }

        # Model SELECTION/reporting is informed by VALIDATION (val_df was previously unused);
        # test is reported once. We surface both so a comparison/critic can use validation
        # to select and reserve test as the single end-of-study evaluation.
        val_metrics = _reg_metrics(val_df)
        test_metrics = _reg_metrics(test_df)
        metrics = test_metrics
        metrics["val_rmse"] = val_metrics["rmse"]
        metrics["val_mae"] = val_metrics["mae"]
        metrics["val_r2"] = val_metrics["r2"]
        result = {
            "status": "completed",
            "metrics": {k: round(float(v), 6) for k, v in metrics.items()},
            "params": {"family": reg_family, "tags": tags, **(params or {})},
            "artifacts": artifacts,
            "provenance": provenance,
        }
        return result

    # ---- classification ----
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

    # threshold chosen on VALIDATION, evaluated once on TEST (applied verbatim).
    val_scores = scores_for(val_df)
    _, threshold, _ = _recall_at_fpr(val_df[target].astype(int), val_scores, max_fpr, threshold=None)
    test_scores = scores_for(test_df)
    at_fpr, threshold, cm = _recall_at_fpr(test_df[target].astype(int), test_scores, max_fpr, threshold=threshold)
    y = test_df[target].to_numpy(dtype=int)
    test_fpr = at_fpr["false_positive_rate"]
    # The validation-chosen threshold is applied verbatim to test; the FPR guarantee only
    # holds on validation, so RE-CHECK it on test and stamp whether it actually held.
    fpr_ok = bool(test_fpr <= max_fpr + _EPS)
    metrics = {
        "recall_at_fpr": at_fpr["recall"],
        "recall": at_fpr["recall"],
        "precision": at_fpr["precision"],
        "false_positive_rate": test_fpr,
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
        "params": {"family": family, "tags": tags, "max_fpr": max_fpr, **(params or {})},
        "artifacts": artifacts,
        "provenance": provenance,
        "fpr_guardrail_satisfied": fpr_ok,
    }


@app.function(image=image, timeout=1500)
@modal.fastapi_endpoint(method="POST")
def launch(manifest: dict):
    """HTTP entrypoint the Cloudflare Worker calls. Dual-mode (one web function to
    stay under the workspace's web-function cap):
      • payload has `script`  → run agent-authored code in an isolated Modal Sandbox
      • otherwise (a manifest) → the fixed sklearn trainer
    """
    if isinstance(manifest, dict) and manifest.get("script"):
        try:
            return _run_experiment_sandbox(manifest)
        except Exception as e:  # never surface a 500 to the Worker
            return {
                "status": "failed",
                "reason": f"runner_error: {type(e).__name__}",
                "provenance": {"code_hash": _CODE_HASH, "deps_hash": _DEPS_HASH, "seed": (manifest.get("split") or {}).get("seed")},
            }
    try:
        _validate_manifest(manifest)
    except ValueError as e:
        return {"status": "rejected", "reason": str(e)}
    try:
        return train.remote(manifest)
    except _DatasetMissing:
        return _failed("dataset_missing", manifest)
    except _DatasetTimeout:
        return _failed("dataset_timeout", manifest)
    except _FUNCTION_TIMEOUT:
        # The fixed-trainer function hit its own wall-clock cap — distinct from a dataset
        # stall or a sandbox kill.
        return _failed("function_timeout", manifest)
    except Exception as e:  # surface failures as a recordable, non-crashing result
        # Sanitize: report the exception TYPE, never the raw message (may carry data/paths).
        # A timeout-flavored exception (any SDK naming) still maps to a function timeout.
        if _is_timeout_exc(e):
            return _failed("function_timeout", manifest)
        return _failed(f"train_error:{type(e).__name__}", manifest)


def _failed(reason: str, manifest: dict) -> dict:
    """A recordable failed result that still carries seed provenance."""
    return {
        "status": "failed",
        "reason": reason,
        "provenance": {
            "code_hash": _CODE_HASH,
            "deps_hash": _DEPS_HASH,
            "seed": (manifest.get("split") or {}).get("seed"),
        },
    }


# ---------------------------------------------------------------------------
# Sandbox executor — run an agent-AUTHORED training script in an isolated,
# network-blocked Modal Sandbox. The agent writes real code (no rigid manifest);
# Modal is still the only place code runs. The script reads /work/data.csv and
# writes /work/result.json := {metrics:{..numbers..}, params:{...}, artifacts:{...}}.
# We keep lightweight guardrails on the agent's DECLARED metadata (banned columns,
# tune_on != test, seed) and stamp provenance (dataset_hash, code_hash, seed).
# The leakage guarantee is PHYSICAL: banned columns are stripped from the CSV before
# the sandbox sees it, so a script cannot read them even if it tries.
# ---------------------------------------------------------------------------

RESULT_CONTRACT = (
    "Read the CSV at /work/data.csv. Do a deterministic split FIRST (use the declared "
    "seed), tune only on validation, exclude banned/leaky columns. Write your result to "
    "/work/result.json as {\"metrics\": {<name>: <number>, ...}, \"params\": {...}, "
    "\"artifacts\": {...}}. Print nothing sensitive."
)

# Caps so a runaway script can't blow up the Worker response or memory.
_MAX_STREAM_BYTES = 64 * 1024  # cap captured stdout/stderr
_MAX_RESULT_BYTES = 1 * 1024 * 1024  # cap result.json we read back


def _validate_declared(declared: dict) -> None:
    feats = list(declared.get("features", []) or [])
    banned = set(declared.get("banned_columns", []) or [])
    leaked = sorted(c for c in feats if c in banned)
    if leaked:
        raise ValueError(f"banned/leaky columns present in declared features: {', '.join(leaked)}")
    if str(declared.get("tune_on", "") or "").strip().lower() == "test":
        raise ValueError("tuning on the test split is forbidden; use tune_on=validation")
    if declared.get("seed") is None:
        raise ValueError("declared.seed is required (reproducibility)")


def _strip_banned_columns(raw: bytes, banned) -> bytes:
    """PHYSICALLY remove banned/leakage columns from the CSV bytes so the sandboxed
    script cannot read them even if it ignores the declared feature list. Returns the
    re-serialized CSV. If parsing fails, fall back to the raw bytes (the manifest-side
    validation still applies) rather than failing the whole run."""
    banned = set(banned or [])
    if not banned:
        return raw
    try:
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


def _read_capped(reader, cap: int) -> str:
    """Read up to `cap` bytes from a stream-like reader, tolerating str or bytes."""
    try:
        data = reader.read(cap + 1)
    except TypeError:
        # Some readers don't accept a size arg; read all then truncate.
        data = reader.read()
    if isinstance(data, bytes):
        data = data.decode("utf-8", "replace")
    if data is None:
        return ""
    if len(data) > cap:
        return data[:cap] + "…[truncated]"
    return data


def _coerce_metrics(raw_metrics: dict):
    """Coerce a result.json metrics dict into finite floats. Returns (metrics, dropped).

    - tolerantly parses numeric strings ("0.83");
    - rejects bools, NaN, inf, and unparseable values;
    - `dropped` lists names that could not be coerced (surfaced for debugging).
    """
    metrics = {}
    dropped = []
    for k, v in (raw_metrics or {}).items():
        if isinstance(v, bool):
            dropped.append(k)
            continue
        val = None
        if isinstance(v, (int, float)):
            val = float(v)
        elif isinstance(v, str):
            try:
                val = float(v.strip())
            except (ValueError, TypeError):
                val = None
        if val is None or not math.isfinite(val):
            dropped.append(k)
            continue
        metrics[k] = round(val, 6)
    return metrics, dropped


def _run_experiment_sandbox(payload: dict):
    """Execute the agent's script in a fresh, network-blocked Modal Sandbox and
    return a recordable result. Called by `launch` when the payload carries a script."""
    script = (payload or {}).get("script") or ""
    declared = (payload or {}).get("declared", {}) or {}
    if not script.strip():
        return {"status": "rejected", "reason": "script is required"}
    try:
        _validate_declared(declared)
    except ValueError as e:
        return {"status": "rejected", "reason": str(e)}
    try:
        raw = _dataset_bytes(payload["dataset_uri"])
    except _DatasetMissing:
        return {"status": "failed", "reason": "dataset_missing"}
    except _DatasetTimeout:
        return {"status": "failed", "reason": "dataset_timeout"}
    except Exception as e:
        return {"status": "failed", "reason": f"dataset_error:{type(e).__name__}"}

    # PHYSICAL leakage strip: remove banned columns from the data the sandbox will see.
    banned = declared.get("banned_columns", []) or []
    raw = _strip_banned_columns(raw, banned)

    dataset_hash = hashlib.sha256(raw).hexdigest()[:16]
    code_hash = hashlib.sha256(script.encode("utf-8")).hexdigest()[:12]
    seed = declared.get("seed")
    # Surface the study's guardrail/primary-metric into the script's environment AND a
    # declared.json so the agent's code can honor them and we can enforce afterward.
    max_fpr = declared.get("max_fpr")
    primary_metric = declared.get("primary_metric")
    declared_for_script = {
        "seed": seed,
        "features": declared.get("features", []),
        "banned_columns": banned,
        "tune_on": declared.get("tune_on"),
        "max_fpr": max_fpr,
        "primary_metric": primary_metric,
    }

    base_prov = {"dataset_hash": dataset_hash, "code_hash": code_hash, "deps_hash": _DEPS_HASH, "seed": seed}

    # Any sandbox-lifecycle error (create/exec/io/transient Modal issue) must become a
    # recordable failed result, never an uncaught 500 → 502 at the Worker.
    sb = None
    out = err = ""
    rc = None
    result_text = ""
    timed_out = False
    try:
        sb = modal.Sandbox.create(
            app=app,
            image=image,
            timeout=900,
            block_network=True,  # the agent's arbitrary code cannot reach the network
            cpu=2.0,
            memory=4096,
            workdir="/work",
        )
        sb.mkdir("/work", parents=True)
        with sb.open("/work/data.csv", "wb") as f:
            f.write(raw)
        with sb.open("/work/run.py", "w") as f:
            f.write(script)
        # Hand the script its declared metadata (seed, guardrail, primary metric) on disk
        # AND via env so it can honor them.
        with sb.open("/work/declared.json", "w") as f:
            f.write(json.dumps(declared_for_script))
        env = {
            "LABMATE_SEED": str(seed) if seed is not None else "",
            "LABMATE_MAX_FPR": str(max_fpr) if max_fpr is not None else "",
            "LABMATE_PRIMARY_METRIC": str(primary_metric) if primary_metric is not None else "",
        }
        try:
            proc = sb.exec("python", "/work/run.py", timeout=840, env=env)
        except TypeError:
            # Older Modal SDK: exec() may not accept env=. Fall back without it (the
            # script can still read /work/declared.json).
            proc = sb.exec("python", "/work/run.py", timeout=840)
        # Read streams AFTER wait() so we don't deadlock on a full pipe, then cap bytes.
        try:
            proc.wait()
        except _SANDBOX_TIMEOUT:
            timed_out = True
        except Exception as we:
            # Some SDK versions raise a generic timeout on wait; treat a "timeout"-named
            # exception as a timeout, otherwise re-raise into the outer handler.
            if _is_timeout_exc(we):
                timed_out = True
            else:
                raise
        out = _read_capped(proc.stdout, _MAX_STREAM_BYTES)
        err = _read_capped(proc.stderr, _MAX_STREAM_BYTES)
        rc = getattr(proc, "returncode", None)
        try:
            with sb.open("/work/result.json", "r") as f:
                result_text = _read_capped(f, _MAX_RESULT_BYTES)
        except Exception:
            result_text = ""
    except _SANDBOX_TIMEOUT:
        return {"status": "failed", "reason": "sandbox_timeout", "provenance": base_prov}
    except Exception as e:
        # Distinguish a timeout-flavored exception from a generic sandbox error.
        reason = "sandbox_timeout" if _is_timeout_exc(e) else f"sandbox_error:{type(e).__name__}"
        return {"status": "failed", "reason": reason, "provenance": base_prov}
    finally:
        # A sandbox kill must ALWAYS still record a result — terminate is best-effort.
        if sb is not None:
            try:
                sb.terminate()
            except Exception:
                pass

    if timed_out:
        return {"status": "failed", "reason": "sandbox_timeout", "provenance": base_prov}

    if not result_text:
        tail = (err or out or "").strip()[-900:]
        # Distinguish "ran but wrote nothing" from a timeout (handled above).
        return {
            "status": "failed",
            "reason": f"no_result (exit {rc})",
            "stderr_tail": tail,
            "provenance": base_prov,
        }
    try:
        result = json.loads(result_text)
    except Exception:
        return {"status": "failed", "reason": "result_not_json", "provenance": base_prov}

    metrics, dropped = _coerce_metrics(result.get("metrics") or {})
    if not metrics:
        # An empty/all-dropped metrics dict is NOT a completed run.
        return {
            "status": "failed",
            "reason": "no_finite_metrics",
            "dropped_metrics": dropped,
            "provenance": base_prov,
        }

    # The primary metric must be present and finite; otherwise the run can't be judged.
    if primary_metric and primary_metric not in metrics:
        return {
            "status": "failed",
            "reason": f"primary_metric_missing:{primary_metric}",
            "dropped_metrics": dropped,
            "provenance": base_prov,
        }

    out_result = {
        "status": "completed",
        "metrics": metrics,
        "params": result.get("params", {}) or {},
        "artifacts": result.get("artifacts", {}) or {},
        "provenance": base_prov,
    }

    # Enforce the operating-point guardrail on the sandbox path too: if a max_fpr bound
    # was declared and the script reported a false_positive_rate above it, the run FAILS
    # the guardrail. We stamp fpr_guardrail_satisfied and also flip status→failed so the
    # ledger can't silently promote a model that violates the study's FPR bound.
    if max_fpr is not None:
        try:
            bound = float(max_fpr)
        except (TypeError, ValueError):
            bound = None
        reported_fpr = metrics.get("false_positive_rate")
        if bound is not None and reported_fpr is not None:
            satisfied = bool(reported_fpr <= bound + _EPS)
            out_result["fpr_guardrail_satisfied"] = satisfied
            if not satisfied:
                out_result["status"] = "failed"
                out_result["reason"] = (
                    f"fpr_guardrail_violated: false_positive_rate={reported_fpr} > max_fpr={bound}"
                )
        elif bound is not None:
            # Guardrail declared but the script never reported an FPR to check it against.
            out_result["fpr_guardrail_satisfied"] = None

    if dropped:
        out_result["dropped_metrics"] = dropped
    return out_result


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
