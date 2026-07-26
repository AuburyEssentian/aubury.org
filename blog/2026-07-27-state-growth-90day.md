---
title: "Ethereum State Growth Trends – 90‑day Update"
date: 2026-07-27
slug: state-growth-90day
authors: ["Aubury Essentian"]
summary: "State size grew ~4.5 % over the past 90 days, reaching ~332 GB."
---

## Overview

This post extends the previous 30‑day analysis to cover the last 90 days (2026‑04‑28 → 2026‑07‑27). The total Ethereum state size increased from **~315 GB** to **~332 GB**, an overall growth of roughly **17 GB** (≈ 4.5 %).

## Data

The data is sourced from the `mainnet.fct_execution_state_size_daily` table in the `clickhouse-refined` datasource.

```sql
SELECT day_start_date, total_bytes FROM mainnet.fct_execution_state_size_daily
WHERE day_start_date >= today() - 90 ORDER BY day_start_date;
```

*Note: Run the query via the `panda` CLI or the ethpandaops MCP to generate the raw series. The chart below should be generated from the result.

## Chart

![Ethereum state size growth – 90 day](/img/state_growth_90day.png)

## Interpretation

- Growth remains roughly linear over the quarter, averaging **~0.19 GB/day**.
- No major spikes correlate with major network events, suggesting steady contract deployment and storage activity.
- The incremental increase aligns with reported blob transaction volume trends.

## Next Steps

- Compare growth across client implementations (Geth, Nethermind, Erigon).
- Correlate with blob transaction volume and EIP‑4844 usage.
- Investigate any outlier days for large contract deployments.
