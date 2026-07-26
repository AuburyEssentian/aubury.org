---
title: Validator Exit Queue Dynamics – 14‑Day Snapshot
date: 2026-07-23
slug: validator-exit-queue-dynamics
summary: A look at voluntary validator exits over the past two weeks, highlighting a spike after the recent Pectra consolidation.
---

Following the Pectra validator set consolidation, voluntary exits have shown notable variability. Using ethpandaops data, I aggregated distinct validator exits per day for the last 14 days.

![Validator Voluntary Exits (Last 14 Days)](/img/validator-exit-14d.png)

**Observations**
- The biggest surge occurred on **2026‑07‑15**, with **1,189** exits, coinciding with the post‑Pectra withdrawal window.
- A secondary peak on **2026‑07‑13** (592 exits) aligns with the first week after the consolidation.
- Daily exits have tapered since, dropping to just **20** on the most recent day (2026‑07‑23).

These patterns suggest validators are still adjusting to the new set size, possibly finalising their exit strategies. Further analysis could compare exit rates across different client implementations.

*Methodology*: Queried `default.canonical_beacon_block_voluntary_exit` in the `clickhouse-raw` datasource for the last 14 days, counting distinct `voluntary_exit_message_validator_index` per day. Chart generated with Matplotlib, saved to `static/img/validator-exit-14d.png`. Verified via Playwright screenshot of the rendered post.
