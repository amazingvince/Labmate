# Data contract — sla_tickets (golden path)

`profile_dataset` fills this in per study. This committed version describes the bundled
`examples/sla_tickets` dataset so the demo is deterministic.

## Target
- **Column**: `breached_sla` (binary: 1 = breached, 0 = met).
- **Definition**: a ticket breached if it was resolved after its SLA deadline, OR is still
  open past the deadline. Defined at the moment of prediction = ticket creation.

## Prediction time
- Prediction is made **at ticket creation**. Any field populated after creation is leakage.

## Leakage candidates (must be reviewed before training)
- `resolved_at` — populated only after resolution.
- `time_to_resolution` — derived from resolution; post-outcome.
- `closed_status` — set at close; post-outcome.
- `agent_notes_final` — written at close; post-outcome.

These default to **banned** unless a human explicitly approves them in the cockpit.

## Safe features (available at prediction time)
- `created_at` (timestamp), `priority`, `customer_tier`, `channel`, `product_area`,
  `region`, `reporter_history_count`, `queue_depth_at_creation`, `is_reopen`,
  `description_length`, `business_hours_flag`.

## Schema sketch
- Row count: ~12,000 (seeded).
- Categoricals: `priority`, `customer_tier`, `channel`, `product_area`, `region`.
- Dates: `created_at`, `resolved_at` (leakage).
- Numeric: `reporter_history_count`, `queue_depth_at_creation`, `description_length`.
- Missingness: `customer_tier` ~6% missing; `region` ~3% missing.

## Split strategy
- **Time-based** split on `created_at` to respect ordering (no random shuffle that leaks
  the future): train = oldest 70%, validation = next 15%, test = newest 15%.
- **Seed**: 42, recorded on every run.
- Tuning happens on **validation only**; test is evaluated once at the end.

## Segments (for stratified evaluation)
- By `customer_tier` (e.g. enterprise vs standard) — enterprise breaches are costlier.
