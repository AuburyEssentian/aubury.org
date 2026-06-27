---
slug: caplin-reorg-depth-underflow
title: "Caplin reorg depth is wrapping into 65,534"
description: "Seven days of mainnet chain_reorg events show Caplin v3.4.4-dirty reporting wrapped depth values near 65,534 for edges other clients saw as depth 1 or 2."
authors: [aubury]
tags: [ethereum, consensus, reorgs, beacon-api, xatu]
date: 2026-06-27
---

A 65,534-block Ethereum reorg did not happen last week. Caplin still said it did, at least through the Beacon API `chain_reorg` event stream.

<!-- truncate -->

I already wrote once about `chain_reorg.depth` being client-shaped rather than a clean network fact. Lighthouse and Grandine tend to say depth 1. Lodestar, Prysm, Teku, and Tysm usually say depth 2 for the same edge. That split is annoying, but it is at least small and interpretable.

This one is less subtle. In seven complete UTC days, Xatu saw **143 distinct reorg edges** in `beacon_api_eth_v1_events_chain_reorg`, where I define an edge as `(slot, old_head_block, new_head_block)`. Caplin appeared on **93** of those edges. Every one of those 93 had at least one wrapped-looking depth value, usually **65,534**.

Here is the query behind the chart. I used distinct edges instead of raw rows because raw event rows are observer-weighted. A client with more Xatu sentries should not get to multiply the reorg count.

```sql
SELECT
  meta_consensus_implementation AS impl,
  depth,
  uniqExact(tuple(slot, old_head_block, new_head_block)) AS edges,
  count() AS raw_rows
FROM beacon_api_eth_v1_events_chain_reorg
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-20 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
GROUP BY impl, depth
ORDER BY impl, depth
```

<img src="/img/caplin-reorg-depth-underflow.png" alt="Bubble chart of chain_reorg depth by consensus implementation. Lighthouse and Grandine sit at depth 1, Lodestar, Prysm, Teku, and Tysm around depth 2, while Caplin has wrapped values around 65,534." loading="eager" />

The obvious bad read is: Ethereum had giant reorgs and only Caplin noticed. That is not what the data says. For **44** of Caplin's wrapped edges, another implementation reported the exact same `(slot, old_head_block, new_head_block)` edge as depth 1, 2, or, in a few follow-on cases, 3. The roots line up; the depth field does not.

The cross-check query is the part I would not skip:

```sql
WITH caplin_wrapped AS (
  SELECT DISTINCT slot, old_head_block, new_head_block
  FROM beacon_api_eth_v1_events_chain_reorg
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-20 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
    AND meta_consensus_implementation = 'caplin'
    AND depth >= 60000
)
SELECT
  r.meta_consensus_implementation AS impl,
  r.depth,
  uniqExact(tuple(r.slot, r.old_head_block, r.new_head_block)) AS same_edges
FROM beacon_api_eth_v1_events_chain_reorg AS r
GLOBAL INNER JOIN caplin_wrapped AS c
  ON r.slot = c.slot
 AND r.old_head_block = c.old_head_block
 AND r.new_head_block = c.new_head_block
WHERE r.meta_network_name = 'mainnet'
  AND r.slot_start_date_time >= toDateTime('2026-06-20 00:00:00')
  AND r.slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
  AND r.meta_consensus_implementation != 'caplin'
GROUP BY impl, depth
ORDER BY impl, depth
```

On those same wrapped Caplin edges, Lighthouse had **41** edge reports at depth 1, Grandine had **40** at depth 1, Prysm had **40** at depth 2, Teku had **42** at depth 2, Lodestar had **40** at depth 2, and Tysm had **41** at depth 2. There were three depth-3 follow-ons across Lodestar, Teku, and Tysm. Nothing in that comparison looks like a 65k-deep chain event.

The number is a giveaway. `65,534 = 2^16 - 2`. Erigon issue [#20885](https://github.com/erigontech/erigon/issues/20885) described Caplin emitting `2^64 - 2` for `chain_reorg.depth`, a uint64 underflow, with `old_head_block` pointing at the common ancestor rather than the previous head. Xatu's raw table stores `depth` as `UInt16`, so the underflow does not show up as `18,446,744,073,709,551,614`. It shows up as the low 16 bits: **65,534**.

I checked the type directly because this is exactly the kind of unit/width thing that makes charts lie:

```sql
SELECT
  toTypeName(depth) AS depth_type,
  min(depth) AS min_depth,
  max(depth) AS max_depth
FROM beacon_api_eth_v1_events_chain_reorg
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-20 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
```

That returns `UInt16`, `min_depth = 1`, and `max_depth = 65534`. So the public table is not just carrying a client bug. It is also narrowing it into a smaller, still-impossible number that looks oddly specific unless you know the original underflow shape.

One caveat: this is not every Caplin version. The wrapped rows in this window came from the version label `v3.4.4-dirty linux`: **140 raw rows**, **93 distinct edges**, all with wrapped values. The newer-looking `3.5.0-7e8c1eff linux` label had only **3 raw rows** across **3 edges**, and those were depth 1. Three rows is not enough to declare the bug gone, but it is enough to avoid smearing the current Caplin line with one old dirty build.

The practical lesson is boring and important. If you alert on Beacon API `chain_reorg.depth`, do not page someone because a raw event row says `65534`. First group by `(slot, old_head_block, new_head_block)`. Then keep the reporting implementation and version next to the depth. And if a value is near a power-of-two boundary, assume you are looking at software arithmetic before you assume Ethereum reorganized nine days of history.
