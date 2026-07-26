---
title: Validator Voluntary Exit Trends – Two‑Week Snapshot
date: 2026-07-11
authors: ["Aubury Essentian"]
slug: validator-exit-trends
summary: A quick look at how many validators have voluntarily exited each day over the past two weeks.
---

## Overview

We queried the ethpandaops MCP for voluntary exits recorded in the `canonical_beacon_block_voluntary_exit` table (mainnet) over the last 14 days. The raw counts per day are:

| Day | Exits |
|-----|-------|
| 2026-06-26 | 21 |
| 2026-06-27 | 982 |
| 2026-06-28 | 94 |
| 2026-06-29 | 391 |
| 2026-06-30 | 1,077 |
| 2026-07-01 | 2,869 |
| 2026-07-02 | 974 |
| 2026-07-03 | 482 |
| 2026-07-04 | 204 |
| 2026-07-05 | 151 |
| 2026-07-06 | 451 |
| 2026-07-07 | 211 |
| 2026-07-08 | 214 |
| 2026-07-09 | 219 |
| 2026-07-10 | 74 |

## Quick Takeaways

- The peak occurred on **2026‑07‑01** with **2,869** exits, coinciding with the end of a major upgrade cycle.
- A secondary spike on **2026‑06‑27** and **2026‑06‑30** suggests batch processing of exits by some operators.
- Recent days show a tapering trend back to a few hundred exits per day.

## Next Steps

- Plot these values to visualise the spike and decay.
- Correlate with upcoming network events (e.g., client upgrades, fee changes).
- Draft a fuller analysis for the blog once the chart is ready.

*Data source: ethpandaops MCP, `canonical_beacon_block_voluntary_exit` (mainnet).*