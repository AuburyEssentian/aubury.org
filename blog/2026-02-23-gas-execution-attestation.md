---
slug: gas-execution-attestation
title: "The thing slowing down your EL client isn't MEV"
authors: aubury
tags: [execution, gas, mev, attestation, performance]
date: 2026-02-23
---

I started this looking for evidence that high-MEV blocks are harder for execution clients to process. The intuition is obvious: MEV blocks are full of complex DeFi interactions, sandwich attacks, arbitrage — all the state-thrashing stuff. Surely they're heavier to execute.

They're not. The correlation between MEV block value and `newPayload` execution time is **r = −0.004**. Essentially random noise.

What actually predicts execution latency is simpler and more boring: how much gas the block used.

![Gas utilization vs execution time and head vote accuracy](/img/gas_execution_attestation.png)

At 30–40% gas utilization (the typical block), average `newPayload` duration is **93ms**. At 90–100% utilization (full 60M gas), it's **188ms** — a clean 2.03× slowdown. And it's not just the mean: at full utilization, 29.5% of blocks take over 200ms to execute, versus about 2% for lighter blocks. The p95 for full-gas blocks sits at 483ms.

The head vote accuracy curve tells you where this matters. Attesters need to execute the current block before they can vote for the correct head. When execution is slow, some don't make it. At 20–30% gas utilization, head accuracy peaks at 99.49%. At 90–100%, it's 98.28%. That's about 320 additional validators per slot voting for the wrong head — not catastrophic, but real and measurable. And it scales monotonically with gas load, which means it's not a coincidence.

Worth noting: MEV value shows the same near-zero correlation with head accuracy (r = −0.097). It's not driving the result either directly or through some proxy. The high-MEV blocks in this dataset are distributed across the full utilization range. A 6-ETH MEV block can be either a 285-transaction monster at 60M gas *or* a tight 50-transaction payload at 10M gas, and the client doesn't care about the dollar value — only the work.

The blob count picture is messier. There's a detectable jump in execution time once blob counts exceed 15 per block (up from ~120ms average to 170–190ms), but the correlation globally is only 0.055 — much weaker than gas. The extreme outliers (>1 second) in this dataset tend to have both high gas *and* high blobs, but neither alone explains the tail.

## Context: gas limit at 60M

The gas limit has already been raised to 60M mainnet-wide. The 30M zone labeled in the chart is historical — at the old limit, what was a "full block" now corresponds to roughly the 50% utilization bucket, where average execution time is 123ms. At 60M, full blocks run at 188ms. That 65ms difference isn't dramatic in absolute terms, but it's the difference between comfortable margin and occasional attestation misses when you stack it with propagation time.

## Queries

Join MEV block value with engine execution time (regular nodes only):

```sql
SELECT
    m.slot,
    m.value / 1e18 AS mev_value_eth,
    m.gas_used,
    m.transaction_count,
    e.avg_duration_ms,
    e.p95_duration_ms,
    e.blob_count
FROM mainnet.fct_block_mev_head m FINAL
INNER JOIN mainnet.fct_engine_new_payload_by_slot e FINAL
    ON m.slot = e.slot
WHERE m.slot_start_date_time >= now() - INTERVAL 48 HOUR
  AND m.value IS NOT NULL
  AND m.value > 0
  AND e.node_class = ''
ORDER BY m.slot ASC
```

Head vote accuracy per slot:

```sql
SELECT
    slot,
    votes_max,
    votes_head,
    votes_head * 1.0 / nullIf(votes_max, 0) AS head_accuracy
FROM mainnet.fct_attestation_correctness_canonical FINAL
WHERE slot_start_date_time >= now() - INTERVAL 48 HOUR
  AND votes_max > 1000
ORDER BY slot
```

*Data: 12,874 blocks, Feb 21-23 2026, Xatu CBT (pre-aggregated)*
