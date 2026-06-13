---
name: leakage-review
description: Detect and block target leakage before training — scan column names for post-outcome signals, check timestamp ordering and feature availability at prediction time, and require explicit human approval to use any suspicious column. Load before proposing or launching experiments.
---

# Leakage review

Run this before any tuned training. The goal: nothing known only *after* the prediction moment reaches a feature list.

**Checks**
1. **Name scan.** Flag columns whose names imply a post-outcome value: `resolved_*`, `closed_*`, `*_final`, `time_to_*`, `outcome`, `label`, `*_at` timestamps later than the prediction time.
2. **Prediction-time availability.** For each candidate feature, ask: is this value populated at the moment of prediction (e.g. ticket creation)? If not, it is leakage.
3. **Timestamp ordering.** The split must respect time order; a future row must never inform a past prediction.
4. **Target definition.** Confirm the target is defined at the prediction moment, not after.

**Action**
- Flagged columns default to **banned**. Using one requires an explicit, recorded human approval (feedback `type: ban_feature` to remove, or an approval to add back).
- Record a `leakage` critique documenting what was found and what was banned. If a run already used a leaky feature, its decision is `rerun` or `reject`.

For `sla_tickets` the planted leakage columns are `resolved_at`, `time_to_resolution`, `closed_status`, `agent_notes_final` — all post-close.
