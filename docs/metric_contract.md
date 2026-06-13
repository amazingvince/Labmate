# Metric contract — sla_tickets (golden path)

`profile_dataset` + the human checkpoint fill this in. This version describes the demo.

## Primary metric
- **Recall** on `breached_sla = 1`. Missing a breach (false negative) is the expensive
  error — a silent SLA miss damages a customer relationship.

## Rationale
- Support teams would rather over-flag at-risk tickets (and intervene) than miss real
  breaches. So recall is prioritized over precision — within a guardrail.

## Guardrails
- **false_positive_rate <= 0.20**. Flagging too many healthy tickets wastes agent time and
  erodes trust in the alert.
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
