#!/usr/bin/env python3
"""
Generate the deterministic synthetic support-ticket SLA-breach dataset for the golden demo.

Why synthetic: it's safe under hackathon rules (non-medical, non-education, non-sports) and
fully reproducible (fixed seed), so the demo behaves the same every time.

Planted-for-demo properties:
  - Post-outcome LEAKAGE columns (resolved_at, time_to_resolution, closed_status,
    agent_notes_final) that the leakage-review skill is meant to catch.
  - A genuine, learnable signal in the SAFE features so honest models still beat baseline.
  - A time index (created_at) so a time-based split is the correct choice.

Usage:  python scripts/gen_dataset.py
Writes: examples/sla_tickets/data.csv  (+ prints a sha256 you can record as dataset_hash)
"""

import csv
import hashlib
import os
import random
from datetime import datetime, timedelta

SEED = 42
N = 12000
OUT = os.path.join(os.path.dirname(__file__), "..", "examples", "sla_tickets", "data.csv")

PRIORITIES = ["low", "medium", "high", "urgent"]
TIERS = ["standard", "standard", "standard", "business", "enterprise"]  # weighted
CHANNELS = ["email", "chat", "phone", "portal"]
PRODUCT_AREAS = ["billing", "auth", "api", "ui", "data", "mobile"]
REGIONS = ["na", "emea", "apac", "latam"]


def main():
    rng = random.Random(SEED)
    start = datetime(2025, 1, 1, 0, 0, 0)

    rows = []
    for i in range(N):
        created = start + timedelta(minutes=rng.randint(0, 60 * 24 * 180))  # ~6 months
        priority = rng.choices(PRIORITIES, weights=[4, 5, 3, 1])[0]
        tier = rng.choice(TIERS)
        channel = rng.choice(CHANNELS)
        product = rng.choice(PRODUCT_AREAS)
        region = rng.choice(REGIONS)
        reporter_history = max(0, int(rng.gauss(8, 6)))
        queue_depth = max(0, int(rng.gauss(30, 18)))
        is_reopen = 1 if rng.random() < 0.07 else 0
        description_length = max(20, int(rng.gauss(220, 120)))
        business_hours = 1 if 9 <= created.hour <= 17 and created.weekday() < 5 else 0

        # --- True breach probability driven ONLY by safe, available-at-prediction features.
        # (Leakage columns below are DERIVED from the outcome, never used to generate it.)
        z = -1.1
        z += {"low": -0.5, "medium": 0.0, "high": 0.6, "urgent": 1.2}[priority]
        z += {"standard": 0.0, "business": 0.2, "enterprise": 0.5}[tier]
        z += 0.015 * (queue_depth - 30)
        z += 0.4 * is_reopen
        z += -0.4 if business_hours else 0.3
        z += {"billing": 0.1, "auth": 0.3, "api": 0.2, "ui": -0.1, "data": 0.2, "mobile": 0.0}[product]
        z += 0.002 * (description_length - 220)
        # logistic
        p = 1.0 / (1.0 + pow(2.718281828, -z))
        breached = 1 if rng.random() < p else 0

        # --- Post-outcome LEAKAGE fields (perfectly correlated w/ outcome on purpose).
        if breached:
            ttr_minutes = int(rng.gauss(900, 300))  # long
            closed_status = rng.choice(["breached_resolved", "breached_open"])
            notes_final = "escalated; SLA missed"
        else:
            ttr_minutes = int(rng.gauss(180, 90))   # short
            closed_status = "within_sla"
            notes_final = "resolved on time"
        ttr_minutes = max(5, ttr_minutes)
        resolved_at = created + timedelta(minutes=ttr_minutes)

        rows.append({
            "ticket_id": f"T{i:06d}",
            "created_at": created.isoformat(),
            "priority": priority,
            "customer_tier": tier if rng.random() > 0.06 else "",      # ~6% missing
            "channel": channel,
            "product_area": product,
            "region": region if rng.random() > 0.03 else "",           # ~3% missing
            "reporter_history_count": reporter_history,
            "queue_depth_at_creation": queue_depth,
            "is_reopen": is_reopen,
            "description_length": description_length,
            "business_hours_flag": business_hours,
            # ---- leakage (post-outcome) ----
            "resolved_at": resolved_at.isoformat(),
            "time_to_resolution": ttr_minutes,
            "closed_status": closed_status,
            "agent_notes_final": notes_final,
            # ---- target ----
            "breached_sla": breached,
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fieldnames = list(rows[0].keys())
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    with open(OUT, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    breach_rate = sum(r["breached_sla"] for r in rows) / len(rows)
    print(f"Wrote {len(rows)} rows -> {os.path.relpath(OUT)}")
    print(f"Breach rate: {breach_rate:.3f}")
    print(f"dataset_hash (sha256): {digest}")


if __name__ == "__main__":
    main()
