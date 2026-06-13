# Study brief — Support ticket SLA breach

We want to predict, **at the moment a support ticket is created**, whether it will breach
its SLA, so the team can intervene early on at-risk tickets.

- **Target**: `breached_sla` (1 = will breach, 0 = will meet SLA).
- **Prediction time**: ticket creation. Anything known only after creation is off-limits.
- **Primary metric**: recall on breaches — missing a real breach is the costly error.
- **Guardrail**: false positive rate must stay at or below 0.20 (don't drown agents in
  false alarms).
- **Do not use** fields created after the ticket is closed (e.g. `resolved_at`,
  `time_to_resolution`, `closed_status`, `agent_notes_final`).
- **Segments**: report enterprise vs the rest separately — enterprise breaches cost more.
- **Budget**: up to ~8 experiments, ~10 minutes of compute, unless raised.

Prioritize a model we can **trust and reproduce** over a marginally higher score.
