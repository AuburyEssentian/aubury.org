---
slug: beacon-eventstream-catchup-tail
title: Beacon API block/head events have a catch-up tail
description: In seven complete UTC days, raw Beacon API block/head rows included 95,597 rows more than 60s after slot start. First-seen reduction left 0 block rows and 1 head row late.
authors: aubury
tags: [ethereum, consensus, beacon-api, xatu, data]
date: 2026-06-25
---

`block` and `head` sound even cleaner than `block_gossip`. A `block` event says the beacon node saw a block. A `head` event says fork choice moved to it. If those rows show up hours after the slot started, the first question should not be "did Ethereum propagate blocks hours late?" It should be "what denominator did I just use?"

The denominator was the row.

<!-- truncate -->

<figure>
  <a href="/img/beacon-eventstream-catchup-tail.png"><img src="/img/beacon-eventstream-catchup-tail.png" alt="Dark chart showing raw Beacon API block/head event rows over 60 seconds late collapsing from 60,619 block rows and 34,978 head rows to 0 block rows and 1 head row after first-seen reduction." loading="eager" /></a>
  <figcaption>Source: Xatu raw <code>beacon_api_eth_v1_events_block</code> and <code>beacon_api_eth_v1_events_head</code>, mainnet, June 18-24 2026 UTC. First-seen means grouped by implementation, slot, and block root.</figcaption>
</figure>

I checked the raw Beacon API `block` and `head` eventstream tables after the `block_gossip` tail turned out to be haunted. The naive query looked ugly in a different way. Across seven complete UTC days, raw `block` rows had **60,619** observations more than 60 seconds after slot start. Raw `head` rows had **34,978**.

There is one annoying footgun before the real finding: I did not use `propagation_slot_start_diff` directly. The stored field is unsigned, and there was one Teku row where the event timestamp was **90 ms before** the slot start. Stored as `UInt32`, that becomes `4,294,967,207 ms`, which is nonsense unless you enjoy debugging fake 49-day delays. So the query below recomputes a signed delay from the timestamps and then does the reduction that matters:

```sql
WITH raw AS (
  SELECT
    meta_consensus_implementation AS impl,
    slot,
    block,
    dateDiff('millisecond', slot_start_date_time, event_date_time) AS signed_ms
  FROM beacon_api_eth_v1_events_block
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-18 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-25 00:00:00')
), firsts AS (
  SELECT
    impl,
    slot,
    block,
    min(signed_ms) AS first_ms,
    max(signed_ms) AS last_ms,
    count() AS rows
  FROM raw
  GROUP BY impl, slot, block
)
SELECT
  countIf(signed_ms > 60000) AS raw_rows_after_60s,
  (SELECT countIf(first_ms > 60000) FROM firsts) AS first_rows_after_60s,
  round(quantileExact(0.99)(greatest(signed_ms, 0)) / 1000, 3) AS raw_p99_s,
  (SELECT round(quantileExact(0.99)(greatest(first_ms, 0)) / 1000, 3) FROM firsts) AS first_p99_s
FROM raw;
```

Run against `block`, that pattern returns **60,619** raw rows after 60 seconds and **0** first rows after 60 seconds. Run the same pattern against `head`, it returns **34,978** raw rows after 60 seconds and **1** first row after 60 seconds. That is the whole trick. The scary rows were late observations of things the same implementation had already observed on time.

The implementation split is noisy but useful as a smell test. Tysm had **27,105** late raw `block` rows and **26,034** late raw `head` rows. Teku had **16,954** late raw `block` rows, and its raw `block` p99 was **269,172 seconds**, or **74.8 hours**. Nimbus had **9,759** late raw `block` rows. Lodestar showed up harder on `head`, with **7,997** late raw rows.

If you stop there, you get a stupid story. Teku did not see normal blocks three days late. Tysm was not moving its head 18 hours after the slot. For the same implementation, slot, and block root, the first row was already timely. In the late-row groups, the first-row p50 was around **1.6-1.8s** for every implementation I checked. The per-implementation first-seen p99 for the `block` event sat between **3.53s** and **3.88s**.

I also joined the late rows back to `canonical_beacon_block` by `(slot, block_root)`, because the other easy mistake is to blame orphans. That did not work either. For `block`, **60,595** of **60,619** late rows matched the canonical root, with **0** conflicting noncanonical joins and **24** no-join rows. For `head`, **34,973** of **34,978** late rows matched the canonical root, again with no conflicting noncanonical joins. These were mostly canonical roots coming back through the eventstream later, not a giant orphan tail.

So the safe query shape is the boring one. If the question is "when did this implementation first surface this block/head?", group by `(meta_consensus_implementation, slot, block)` and take `min(event_date_time - slot_start_date_time)`. If the question is global first seen, drop the implementation from the grouping. If the question is eventstream replay, keep the raw rows and stare at the tail directly.

This is an observed Xatu Beacon API eventstream surface. It is not a client market-share claim, and it is not proof about why a particular client emitted catch-up rows. It just says raw `block` and `head` rows are not unique block/head timing events.

The block was not late. The row was.
