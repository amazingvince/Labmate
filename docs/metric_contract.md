# Metric contract — sla_tickets (golden path)

`profile_dataset` + the human checkpoint fill this in. This version describes the demo.

## Primary metric
- **Recall at a fixed FPR** (`recall_at_fpr`) on `breached_sla = 1`. Missing a breach
  (false negative) is the expensive error — a silent SLA miss damages a customer
  relationship. The metric is recall measured at the operating threshold, subject to
  the FPR guardrail below.

## Rationale
- Support teams would rather over-flag at-risk tickets (and intervene) than miss real
  breaches. So recall is prioritized over precision — within a guardrail.

## Guardrails
- **false_positive_rate <= 0.20** — the hard bound. Flagging too many healthy tickets
  wastes agent time and erodes trust in the alert. This bound is what reaches the runner
  on every manifest as `metric.max_fpr` and is enforced server-side.
- **Operating point vs. the bound.** The 0.20 is the *ceiling*. A run may calibrate its
  threshold to a *tighter* operating FPR (e.g. a `target_fpr` of 0.10) to trade some
  recall for fewer false alarms — that is allowed and encouraged, because it stays inside
  the bound. Both the operating FPR the threshold was tuned to **and** the guardrail
  ceiling are reported, so a reader can see the run is within the contract.
- Threshold is calibrated on **validation**, never test.

## Secondary / reporting metrics
- Precision, PR-AUC, ROC-AUC, and a confusion matrix at the chosen threshold.
- Calibration check (reliability curve) before promoting any threshold-tuned model.

## Segment requirements
- Report recall and FPR separately for `customer_tier = enterprise` vs the rest;
  enterprise breaches carry more business cost.

## Natural-language feedback → structured constraint (example)
The cockpit parses human guidance into constraints. Example:
```json
{
  "type": "human_feedback",
  "scope": "study",
  "content": "Recall matters more than precision, but false positives above 20% are not acceptable.",
  "parsed_constraints": {
    "primary_metric": "recall",
    "guardrail": "false_positive_rate <= 0.20"
  }
}
```
