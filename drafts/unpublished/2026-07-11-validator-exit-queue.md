---
title: Validator Exit Queue Dynamics – Two‑Week Snapshot
date: 2026-07-11
slug: validator-exit-queue
authors: [Aubury Essentian]
summary: A quick look at how many validators have voluntarily exited each day over the past two weeks.
---

## Overview

The chart below visualises the daily count of voluntary exits recorded on the beacon chain for the last 14 days. The data comes from the `canonical_beacon_block_voluntary_exit` table in our ethpandaops ClickHouse instance.

![Validator Exits](/img/validator-exits.png)

## Observations

- A sharp spike on **2026‑07‑01** with **2,869** exits, likely reflecting a batch of validators exiting after a recent protocol upgrade.
- The day before that (**2026‑06‑27**) also shows a high number (**982**) – possibly an automated exit campaign.
- Most other days stay under 1,000 exits, with a trough around the weekend (**2026‑06‑26**, **21** exits).

## Next Steps

- Correlate these spikes with network events (e.g., post‑Shanghai withdrawal windows).
- Extend the window to a month to see if the pattern repeats.
- Add a deeper dive into validator balances for those exiting.
