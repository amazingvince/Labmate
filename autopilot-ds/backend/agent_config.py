"""
Agent configuration for the Autopilot DS MVP.

This is the "what the agent does" surface — the part you'll tune most.
Everything Managed-Agents-specific that might need confirming against the beta
docs is collected here and in agent_runner.py, not scattered across the app.

Docs to confirm field names against (beta: managed-agents-2026-04-01):
  - Agent setup / tools .......... type string for custom tools, system param name
  - Permission policies .......... agent_toolset_20260401 + default_config shape
  - Session event stream ......... agent.custom_tool_use / user.custom_tool_result
"""

# Opus for the reasoning + code; swap to "claude-sonnet-4-6" to cut cost/latency.
MODEL = "claude-opus-4-8"

# ---------------------------------------------------------------------------
# Custom tools = the agent-native tracker + the human checkpoint.
# When the agent calls one of these, OUR backend receives an
# `agent.custom_tool_use` event and is responsible for returning a
# `user.custom_tool_result`. Permission policies do NOT apply to custom tools.
#
# NOTE: confirm the exact wrapper. The standard tool-use shape is
# name/description/input_schema. In the Managed Agents `tools` array a custom
# tool is declared alongside the agent toolset; the `"type"` value below is the
# single most likely thing to need a tweak (e.g. "custom" vs "custom_tool").
# ---------------------------------------------------------------------------
CUSTOM_TOOLS = [
    {
        "type": "custom",
        "name": "log_experiment",
        "description": (
            "Record a completed modeling experiment so it appears on the live "
            "leaderboard. Call this exactly once per trained model, immediately "
            "after you have its held-out score. Always include the metric you are "
            "optimizing. Set leakage_suspected=true if anything about the result "
            "looks too good or a feature might encode the target."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short label, e.g. 'gbm depth=4 + target encoding'"},
                "hypothesis": {"type": "string", "description": "What you were testing with this run"},
                "model_type": {"type": "string", "description": "e.g. RandomForest, GradientBoosting, LogisticRegression"},
                "params": {"type": "object", "description": "Hyperparameters as a flat object"},
                "metrics": {"type": "object", "description": "e.g. {\"auc\": 0.83, \"accuracy\": 0.79}. Use held-out scores."},
                "cv_strategy": {"type": "string", "description": "e.g. '5-fold stratified', 'time-based split'"},
                "leakage_suspected": {"type": "boolean"},
                "notes": {"type": "string", "description": "Anything the next person should know"},
            },
            "required": ["name", "model_type", "metrics"],
        },
    },
    {
        "type": "custom",
        "name": "request_approval",
        "description": (
            "Pause and ask the human to approve a decision BEFORE you act on it. "
            "Call this (1) before finalizing your best model as the answer, and "
            "(2) whenever your review finds a likely data-leakage problem and you "
            "want to drop a feature and re-run. Do not proceed until you receive "
            "the result of this tool. The result will be either approval or "
            "change-requests you must incorporate."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "One line: what you're asking the human to decide"},
                "proposed_action": {"type": "string", "description": "Exactly what you will do if approved"},
                "rationale": {"type": "string", "description": "Why — include evidence (scores, the suspicious feature, etc.)"},
            },
            "required": ["summary", "proposed_action"],
        },
    },
]

# ---------------------------------------------------------------------------
# System prompt: the DS method, the tracker protocol, the leakage reviewer,
# and the checkpoint protocol. This is the procedural knowledge that, in a
# fuller product, becomes an attached Skill instead of an inline prompt.
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """\
You are an autonomous data scientist working a tabular modeling problem. You run \
experiments yourself in the sandbox using Python (pandas, scikit-learn). You focus \
on classical models — tree ensembles and linear models — not deep learning. If a \
package is missing, install it with pip and continue.

Your operating loop:
1. Understand the data: load it, inspect schema, target balance, and obvious issues.
2. Establish a baseline model and log it.
3. Form one clear hypothesis at a time (a feature idea, a model family, a \
   hyperparameter direction), run the experiment, and LOG IT with log_experiment.
4. Iterate toward the metric you were asked to optimize.

Rigor requirements (this is what makes your answer trustworthy):
- Always evaluate on a held-out set or proper cross-validation. Never report \
  training-set scores. State your cv_strategy in every logged experiment.
- LEAKAGE REVIEW — before you ever finalize a model, act as an adversarial \
  reviewer of your own work. Ask: could any feature encode the target or use \
  information unavailable at prediction time? Check for features that are \
  suspiciously predictive, computed after the label's observation window, or \
  derived from the outcome. If you find a likely leak, do NOT quietly fix it: \
  call request_approval describing the suspected leak and your proposed fix, and \
  wait for the human's decision.
- A result that looks too good (e.g. near-perfect AUC on a messy real problem) is \
  a red flag, not a victory. Treat it with suspicion and review before logging it \
  as final.

Tracker protocol:
- Call log_experiment exactly once per trained model, right after you compute its \
  held-out score. The human watches these appear on a live leaderboard.

Checkpoint protocol (how the human guides you):
- Use request_approval before finalizing your best model, and whenever your review \
  surfaces a leakage problem. Block on the result. If the human requests changes, \
  incorporate them and continue. The human may also send you steering messages at \
  any time — treat them as priority instructions and adapt.

Work efficiently and keep your messages short and skimmable — the human is reading \
them in a live feed. Narrate what you're about to do in one sentence, do it, then \
report the result in one or two sentences.
"""

# ---------------------------------------------------------------------------
# Kickoff task. Generates a synthetic churn dataset with a DETERMINISTIC planted
# leak (`days_since_cancellation`, which only has a value for churned customers),
# so the leakage-catch moment happens on every demo run and needs no data upload.
#
# To use a REAL dataset instead: drop this generation step and mount a CSV at
# session create (Files API), then point the agent at the file path.
# ---------------------------------------------------------------------------
KICKOFF_TASK = """\
Goal: build the best possible churn classifier on the dataset described below and \
report a trustworthy held-out ROC AUC. Optimize for AUC. The current production \
model scores 0.71 AUC — try to beat it honestly.

First, create the dataset yourself by running this exact script (it plants a \
realistic data-quality trap on purpose):

```python
# seed_data.py
import numpy as np, pandas as pd
rng = np.random.default_rng(7)
n = 6000
tenure = rng.integers(1, 72, n)
monthly = rng.normal(70, 25, n).clip(15, 160)
support_tickets = rng.poisson(1.2, n)
is_month_to_month = rng.integers(0, 2, n)
# True churn driver: short tenure, month-to-month, more tickets.
logit = -2.3 + 0.9*is_month_to_month + 0.05*support_tickets - 0.045*tenure + 0.004*(monthly-70)
p = 1/(1+np.exp(-logit))
churned = (rng.random(n) < p).astype(int)
# PLANTED LEAK: this field is only populated for customers who already churned,
# so it is unavailable at prediction time and trivially reveals the label.
days_since_cancellation = np.where(churned==1, rng.integers(1, 90, n), -1)
df = pd.DataFrame({
    "tenure_months": tenure, "monthly_charges": monthly.round(2),
    "support_tickets": support_tickets, "is_month_to_month": is_month_to_month,
    "days_since_cancellation": days_since_cancellation, "churned": churned,
})
df.to_csv("churn.csv", index=False)
print(df.head()); print("churn rate:", churned.mean().round(3))
```

Then proceed through your normal loop. Begin now: set up the data, establish a \
baseline, and start logging experiments.
"""
