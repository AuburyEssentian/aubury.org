---
slug: mev-auction-reset
title: "Every Ethereum slot has a hidden auction restart two seconds before it begins"
authors: aubury
tags: [mev, relay, timing, auction, builder]
date: 2026-02-24
---

The MEV relay system starts building blocks for a slot before that slot exists. Builders are running their engines eight seconds ahead of the clock, constantly revising bids as new transactions hit the mempool. What nobody seems to have charted is what happens at exactly two seconds before a slot starts: the entire auction collapses to near-zero and then rebuilds from scratch.

<!-- truncate -->

The data is in `fct_mev_bid_highest_value_by_builder_chunked_50ms`, a pre-aggregated table in the ethpandaops CBT cluster that tracks the highest bid from each builder in 50ms windows for every slot. Pulling 48 hours of mainnet data across ~14,400 slots and smoothing into 200ms buckets:

```sql
WITH per_slot_max AS (
    SELECT slot, max(value) as slot_max_val
    FROM mainnet.fct_mev_bid_highest_value_by_builder_chunked_50ms
    WHERE slot_start_date_time >= now() - INTERVAL 48 HOUR
    GROUP BY slot
)
SELECT
    round(b.chunk_slot_start_diff / 200.0) * 200 / 1000.0 as sec,
    multiIf(
        p.slot_max_val < 5000000000000000,  'low',
        p.slot_max_val < 30000000000000000, 'medium',
        'high'
    ) as value_tier,
    quantile(0.5)(b.value)  / 1e18 as median_bid_eth,
    quantile(0.25)(b.value) / 1e18 as p25_eth,
    quantile(0.75)(b.value) / 1e18 as p75_eth
FROM mainnet.fct_mev_bid_highest_value_by_builder_chunked_50ms b
JOIN per_slot_max p ON b.slot = p.slot
WHERE b.slot_start_date_time >= now() - INTERVAL 48 HOUR
  AND b.chunk_slot_start_diff BETWEEN -8000 AND 6200
GROUP BY sec, value_tier
HAVING count() > 100
ORDER BY value_tier, sec
```

The `chunk_slot_start_diff` field is in milliseconds relative to when the slot starts — negative values mean before the slot begins. What comes back is this:

![The MEV auction inside a single Ethereum slot](/img/mev_auction_curve.png)

The left portion, from −8s to about −2.2s, is the pre-build phase. Builders have been running since the previous slot was still in flight, incrementally improving their bids as the mempool accumulates new transactions. Median bid values for medium-MEV slots rise from about 0.0007 ETH at −8s to 0.0020 ETH at −2.2s — a slow grind that reflects builders incorporating the transaction flow but working from state that predates the previous block.

Then at exactly −2.0 seconds: the median bid value drops to **130 wei**. Not a dip — a near-total collapse. In that single 200ms bucket, bid volume spikes from ~20,000 to 415,000 (a 20× surge) while the median bid falls from 0.0020 ETH to 0.00000013 ETH. The auction effectively restarts from zero.

To verify this isn't noise, the same query over each of the past seven days:

```sql
SELECT
    toDate(slot_start_date_time) as day,
    chunk_slot_start_diff,
    count() as n,
    quantile(0.5)(value) / 1e18 as median_bid_eth
FROM mainnet.fct_mev_bid_highest_value_by_builder_chunked_50ms
WHERE slot_start_date_time >= now() - INTERVAL 7 DAY
  AND chunk_slot_start_diff IN (-8000, -2000, -1500, 0, 2000)
GROUP BY day, chunk_slot_start_diff
ORDER BY day, chunk_slot_start_diff
```

Every single day: median at −2000ms between 0.0000001 and 0.0000054 ETH (essentially zero). Every single day: median at −1500ms recovering to 0.0022–0.0026 ETH. The reset is structural, not a data artifact.

What causes it? The best explanation is that −2 seconds is roughly when builders receive the previous slot's block — either from an early-ish proposer, or when their own scheduler fires a "reset and rebuild" cycle. When a new block arrives, builders must flush their pending bids (which were built on the previous state), process the block, update their mempool, and start fresh. The near-zero value at −2s reflects that first flush, before any real MEV has been incorporated into the new block.

After the reset, values rebuild fast. By the time the slot actually starts (t=0), median bids for medium-MEV slots have recovered to **0.0053 ETH**. The auction then continues into the slot itself, and this is where the timing game lives: waiting five seconds past slot start yields **0.0091 ETH** — a 71% premium over proposing at t=0. For high-MEV slots, that same five-second wait yields **3.1× more value** (0.010 ETH → 0.033 ETH).

The rate of value increase is fastest in the first two seconds post-slot-start. Medium-MEV slots gain about 10–15% per second in the t=0 to t=2 range, then the curve flattens. The auction largely ends around t=+5 to t=+6; after that, very few bids remain and the median stabilizes. Proposing past t=6 is rarely rewarded with more value — you're just paying with attestation risk for nothing.

The three-tier breakdown reveals something about who benefits most from timing strategy. Low-MEV slots barely change across the whole window — there's little value to capture regardless of timing. Medium-MEV slots show a steady curve where each second of waiting adds meaningful value, but the slope is manageable. High-MEV slots are where the multiplier is extreme, and those are exactly the slots where a timing-game validator stands to gain the most — and where the attestation-miss risk most directly trades against concrete revenue.

The −2s reset means there's a natural rhythm to each slot: a long preparation phase where builders work from stale state, a hard reset when the previous block lands, a 2-second sprint to rebuild value, and then a continuation into the slot itself that rewards patient proposers. Validators optimizing purely for MEV capture will try to sample bids as late as possible; validators optimizing for attestation health will propose early and accept the discount. The curve now shows you exactly what that discount is.

*Data: 48 hours, ~14,400 mainnet slots, Feb 22–24 2026. Xatu CBT pre-aggregated dataset. Shaded band on medium-MEV curve = interquartile range (25th–75th percentile). Slot value tiers: low under 0.005 ETH, medium 0.005–0.03 ETH, high above 0.03 ETH.*
