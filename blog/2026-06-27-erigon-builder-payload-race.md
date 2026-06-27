---
slug: erigon-builder-payload-race
title: Erigon 3.5-dev did not win the builder payload race
description: In 24 hours of eip7870 builder telemetry, two Erigon 3.5-dev nodes saw the same 7,174 payloads as the other clients. Erigon's best observed node was 11.45x slower than the fastest peer at median and won one fastest slot.
authors: aubury
tags: [ethereum, erigon, execution, builders, xatu]
date: 2026-06-27
---

Erigon 3.5.0 landed with a very good headline: parallel block execution is on by default. That should make Ethereum block validation feel less serial, at least where the workload and configuration let it pay off.

The builder-class telemetry I checked had the opposite shape. Two observed Erigon `3.5.0-dev-8b4c6990` nodes processed the same 7,174 mainnet payloads as the other eip7870 builder nodes. Giving every implementation its fastest observed node in each slot, Erigon's median was **283 ms**. The fastest non-Erigon observation in each slot had a **24 ms** median; Reth's own per-implementation median was **25 ms**. Erigon won **one** fastest slot.

<!-- truncate -->

<img src="/img/erigon-builder-payload-race.png" alt="Dark two-panel chart showing eip7870 builder engine_newPayload validation times and fastest-slot share. Erigon 3.5-dev has a 283 ms median best-node time and one fastest slot out of 7,174." loading="eager" />

I am not calling this an Erigon-wide benchmark. It is two dev-version builder-class nodes in Xatu's observed sample, not the public mainnet population, and I am deliberately not publishing the node names. It is still a useful little contradiction: the version string says `3.5.0-dev`, the release headline says parallel execution, and this monitored builder path is nowhere near the payload-validation front.

Here is the generous cut. For each slot and implementation, I took the fastest `VALID` `engine_newPayload` duration among the observed eip7870 builder nodes. That removes the "one slow node made the client look bad" excuse before the comparison starts.

```sql
WITH per_impl AS (
  SELECT
    slot,
    meta_execution_implementation AS impl,
    minIf(duration_ms, status = 'VALID') AS min_ms,
    quantileIf(0.5)(duration_ms, status = 'VALID') AS med_ms
  FROM mainnet.int_engine_new_payload FINAL
  WHERE slot_start_date_time >= toDateTime('2026-06-25 23:40:00')
    AND slot_start_date_time <  toDateTime('2026-06-26 23:40:00')
    AND node_class = 'eip7870-block-builder'
    AND status = 'VALID'
    AND meta_execution_implementation IN (
      'erigon', 'Reth', 'Nethermind', 'ethrex', 'go-ethereum', 'Besu'
    )
  GROUP BY slot, impl
)
SELECT
  impl,
  count() AS matched_slots,
  round(quantile(0.5)(min_ms), 1) AS p50_best_node_ms,
  round(quantile(0.95)(min_ms), 1) AS p95_best_node_ms,
  round(quantile(0.5)(med_ms), 1) AS p50_median_node_ms
FROM per_impl
GROUP BY impl
ORDER BY p50_best_node_ms;
```

That produced the clean version of the chart: Reth at **25 ms** p50, ethrex **32 ms**, Nethermind **33 ms**, go-ethereum **69 ms**, Besu **112 ms**, Erigon **283 ms**. The p95 line was not close either: Erigon's best-node p95 was **644 ms**, while Reth was **53 ms** and Nethermind was **64 ms**.

The less generous per-call view was uglier. Across `14,312` valid Erigon calls, the raw per-call median was **430 ms** and p95 was **1,154 ms**. There were also **36** `SYNCING` responses in the Erigon sample. I left those out of the duration quantiles, because this post is about validation speed when the response was valid, not sync-state failures.

The fastest-slot table is even more blunt.

```sql
SELECT
  meta_execution_implementation AS impl,
  count() AS fastest_slots,
  round(count() * 100.0 / sum(count()) OVER (), 3) AS fastest_pct
FROM mainnet.int_engine_new_payload_fastest_execution_by_node_class FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-25 23:40:00')
  AND slot_start_date_time <  toDateTime('2026-06-26 23:40:00')
  AND node_class = 'eip7870-block-builder'
GROUP BY impl
ORDER BY fastest_slots DESC;
```

Reth was fastest in **5,573** slots, or **77.683%** of the window. Nethermind had **926**. Ethrex had **674**. Erigon had **1**, which is **0.014%**. Geth and Besu had none in this node class during the same cut.

I also checked the "maybe Erigon got harder blocks" version of the story. It did not hold. Every implementation in the chart matched all **7,174** slots, and the payload-size buckets kept the same ordering. In the `45-60M` gas bucket, Erigon's best-node p50 was **472 ms** while Reth's was **44 ms**. In the tiny `<15M` gas bucket, Erigon was still **120 ms** versus Reth at **12 ms**. For `19-21` blob slots, Erigon was **349 ms** versus Reth at **31 ms**.

There is a decent chance the interesting part is configuration, not the execution engine in isolation. Builder nodes are weird machines. They run different surrounding workloads, they may be pinned differently, and a dev build can be carrying instrumentation or flags that the stable release does not. The public Erigon 3.5.0 release note says "parallel block execution, on by default," but this sample is `3.5.0-dev`, so I would not read the chart as "parallel execution failed."

The safer read is narrower and more useful: do not assume the version headline shows up in the observed validation clock. In this builder-class slice, on these 7,174 mainnet payloads, Erigon 3.5-dev was the slow lane. Still comfortably inside a 12-second slot, but nowhere near the race it was supposed to be in.
