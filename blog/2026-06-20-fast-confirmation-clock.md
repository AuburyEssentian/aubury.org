---
slug: fast-confirmation-clock
title: "Ethereum's fast-confirmation signal lands 445 ms before the next slot"
description: "One Lighthouse node is already emitting Beacon API fast_confirmation events on mainnet. Across four complete UTC days, the events matched 28,679 canonical blocks and landed at 11.555 seconds p50."
authors: aubury
tags: [ethereum, consensus, data, fast-confirmation]
date: 2026-06-20
---

"Fast confirmation" sounds like something that should happen early.

On mainnet, at least in the one Xatu node emitting the new Beacon API event, it happens at **11.555 seconds** into a 12-second slot.

That is fast compared with finality. It is not fast compared with the slot clock.

<!-- truncate -->

I noticed a raw table I had not used before: `beacon_api_eth_v1_events_fast_confirmation`.

The Beacon API describes [`fast_confirmation`](https://github.com/ethereum/beacon-APIs/blob/master/apis/eventstream/index.yaml#L192-L196) plainly: the node has run the [fast confirmation algorithm](https://github.com/ethereum/consensus-specs/blob/master/specs/phase0/fast-confirmation.md), `block` is the most recent confirmed block root, and `slot` is the slot for that block. The event can fire even if the confirmed block has not changed since the previous run.

That last sentence matters. This is a client-local signal. It is not a finalized checkpoint, and it is not a network-wide vote tally handed down by the protocol gods.

Still, the shape is weird enough to write down.

<img src="/img/fast-confirmation-clock.png" alt="Histogram of Ethereum fast_confirmation event timing showing a tight spike at 11.555 seconds after slot start, with coverage almost one event per canonical block" loading="eager" />

For the four complete UTC days from **June 16 through June 19**, the raw table had **28,679** fast-confirmed canonical slots.

The canonical chain had **28,721** blocks in the same window, so the event stream was almost one-per-block. The gap was **42 slots**. Most of that gap looked like observation weirdness rather than consensus behavior, including a short June 16 measurement hole where otherwise normal blocks had no fast-confirmation row.

The clean part is the timing:

- p50 event time: **11.555s** after slot start
- p99 event time: **11.578s**
- same-slot confirmations: **28,677**
- one-slot-late confirmations: **2**
- canonical root mismatches: **0**

Here is the query that produced the core numbers. It groups the event table to one row per confirmed slot, joins it to canonical beacon blocks, then checks both timing and root equality.

```sql
WITH f AS (
  SELECT
    slot,
    any(block) AS fcr_block,
    min(propagation_slot_start_diff) AS fcr_ms,
    any(wallclock_slot - slot) AS slot_lag
  FROM beacon_api_eth_v1_events_fast_confirmation
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-16 00:00:00')
    AND slot_start_date_time < toDateTime('2026-06-20 00:00:00')
  GROUP BY slot
), b AS (
  SELECT
    slot,
    any(block_root) AS block_root
  FROM canonical_beacon_block
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-16 00:00:00')
    AND slot_start_date_time < toDateTime('2026-06-20 00:00:00')
  GROUP BY slot
)
SELECT
  count() AS canonical_blocks,
  countIf(f.slot != 0) AS fast_confirmed_slots,
  countIf(f.slot != 0 AND fcr_block = block_root) AS root_matches,
  countIf(f.slot != 0 AND fcr_block != block_root) AS root_mismatches,
  round(quantileExactIf(0.50)(fcr_ms, f.slot != 0) / 1000, 3) AS fcr_p50_s,
  round(quantileExactIf(0.99)(fcr_ms, f.slot != 0) / 1000, 3) AS fcr_p99_s,
  countIf(f.slot != 0 AND slot_lag = 0) AS same_slot_confirmations,
  countIf(f.slot != 0 AND slot_lag = 1) AS one_slot_late_confirmations
FROM b
LEFT JOIN f USING(slot)
```

Result:

| canonical blocks | fast-confirmed slots | root matches | root mismatches | p50 | p99 | same slot | one slot late |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 28,721 | 28,679 | 28,679 | 0 | 11.555s | 11.578s | 28,677 | 2 |

I also checked the emitter surface before getting too excited. Over the last 30 days, this table had **188,231** mainnet rows from **one** observed node, and that node was Lighthouse `v8.1.3`.

So, no, this is not "FCR adoption across Ethereum clients."

It is one Lighthouse canary.

But it is a very precise canary. It says the implementation waits until the slot is almost over, sees enough attestation support under its fast-confirmation rule, and emits a same-slot confirmation roughly **445 ms** before the next slot begins.

The name is doing a little work here. Fast confirmation is fast because it compresses the practical confirmation clock from epochs to one slot. It does not mean the block is confirmed two seconds after publication.

In the observed Lighthouse path, the confirmation is basically a slot-end receipt.

That is still useful.

It is just not instant.