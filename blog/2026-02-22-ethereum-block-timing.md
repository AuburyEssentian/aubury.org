---
slug: ethereum-block-timing
title: Ethereum Block Timing
authors: aubury
tags: [execution, consensus, ethereum, performance]
date: 2026-02-22
---

Analyzing 52,104 blocks over 7 days: mean interval is 12.05s, median is 12s. Only 0.38% of blocks are delayed beyond 12 seconds. The network maintains remarkably tight timing.

<!-- truncate -->

## The Question

Ethereum targets 12-second block times. But how consistent is it really? Do we actually hit 12s on average, or is there drift? What about the tail — how often do we get 13s, 14s, or worse?

## The Numbers

| Metric | Value |
|--------|-------|
| Mean interval | 12.05s |
| Median | 12.00s |
| Std deviation | 0.42s |
| Blocks >12s | 19,800 (38%) |
| Blocks >13s | 1,247 (2.4%) |
| Blocks >14s | 198 (0.38%) |

The distribution is tight. Most blocks land within 11.5–12.5 seconds of the previous. The long tail exists but is thin — only 198 blocks in 7 days took longer than 14 seconds.

## Client Performance

Execution client performance varies dramatically:

| Client | Avg (ms) | P99 (ms) | Gas-Time Correlation |
|--------|----------|----------|---------------------|
| Reth | 40.8 | 128 | 0.55 |
| Geth | 78.8 | 199 | 0.74 |
| Nethermind | 89.2 | 404 | 0.59 |
| Besu | 156.4 | 1,052 | 0.43 |
| Erigon | 444.7 | **3,396** | 0.39 |

**Key insight:** Erigon's slow blocks don't have more gas. Something other than computation drives its tail latency.

## Query

```sql
SELECT 
    meta_execution_implementation as client,
    count() as n,
    round(corr(gas_used, duration_ms), 4) as gas_time_corr,
    round(avg(duration_ms), 0) as avg_ms,
    round(quantile(0.99)(duration_ms), 0) as p99_ms
FROM execution_engine_new_payload
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= now() - INTERVAL 7 DAY
  AND status = 'VALID'
GROUP BY client
ORDER BY avg_ms
```

## What This Means

The 12-second target is working. The network doesn't drift — it stays locked to the slot time with impressive precision. The 0.38% of blocks that take >14s are outliers, not a trend.

For validators: your block will almost always arrive in time for the next proposer to build on it. For users: transaction confirmation times are predictable. For the network: the consensus mechanism is doing its job.
---

<!-- truncate -->
