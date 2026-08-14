---
slug: empty-slot-attestation-backlog
title: "The block after an empty slot earns 74% more attestation reward"
description: "Across 30 complete mainnet days, blocks after one slot without a canonical block earned 73.6% more attestation proposer reward. The protocol weights explain almost the exact ratio."
authors: aubury
tags: [ethereum, consensus, attestations, validators, rewards, xatu, data]
date: 2026-08-14
---

Missing a block does not make its attestations disappear. They turn up one slot later, and the next proposer gets paid for including both cohorts.

Across 30 complete mainnet days, a regular canonical block earned a median **0.048761995 ETH** from included attestations. A block after exactly one slot without a canonical block earned **0.084636038 ETH**, or **73.57% more**. That gap showed up on all 30 days, not in one ugly incident window.

<!-- truncate -->

<figure>
  <a href="/img/empty-slot-attestation-backlog.png">
    <img src="/img/empty-slot-attestation-backlog.png" alt="Canonical mainnet blocks after one empty slot earned 73.6 percent more median attestation proposer reward than regular blocks, with roughly twice as many attester positions split between age-one and age-two cohorts." loading="eager" />
  </a>
  <figcaption>An "empty slot" here means a scheduled slot with no canonical block. It can be classified as missed or orphaned; it does not prove that nobody produced a block.</figcaption>
</figure>

The useful field is not a timing estimate. It is the slot difference between consecutive exact canonical block roots. A gap of one is the normal case. A gap of two means the previous scheduled slot had no canonical block, while a gap of three means two consecutive slots were empty.

Here is the query behind the reward numbers. `canonical_beacon_block_reward` is already one row per canonical block in this window, but I still checked row count against unique slots and roots before using it.

```sql
WITH rewards AS (
  SELECT
    slot,
    total,
    attestations,
    sync_aggregate,
    proposer_slashings,
    attester_slashings
  FROM default.canonical_beacon_block_reward FINAL
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-07-15 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-14 00:00:00')
), with_gap AS (
  SELECT
    *,
    slot - lagInFrame(slot, 1, slot)
      OVER (
        ORDER BY slot
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS canonical_gap
  FROM rewards
)
SELECT
  canonical_gap,
  count() AS blocks,
  quantileExact(0.5)(attestations) / 1e9 AS median_attestation_reward_eth,
  quantileExact(0.5)(total) / 1e9 AS median_total_reward_eth,
  quantileExact(0.5)(sync_aggregate) / 1e9 AS median_sync_reward_eth,
  countIf(
    total != attestations + sync_aggregate
      + proposer_slashings + attester_slashings
  ) AS component_mismatches
FROM with_gap
WHERE canonical_gap > 0
GROUP BY canonical_gap
ORDER BY canonical_gap;

-- gap 1: 214,453 blocks, 0.048761995 ETH median attestation reward
-- gap 2:     770 blocks, 0.084636038 ETH median attestation reward
-- gap 3:       2 blocks
-- component mismatches: 0 in every bucket
```

The 30-day clock permits **216,000 scheduled slots**. A separate `fct_block_proposer_by_validator FINAL` path split them into **215,226 canonical, 518 missed and 256 orphaned** slots. The gap query independently accounts for the same 774 slots without canonical blocks: `770 × 1 + 2 × 2 = 774`.

The sync committee component barely moved, from a median **0.001803400 ETH** on regular blocks to **0.001803399 ETH** after one empty slot. Neither slashing component had a nonzero row in the window. The extra **0.035874043 ETH** therefore came from the attestation component, not from a lucky sync committee or slashing inclusion.

## Why it lands on 1.74x

The reward ratio looked too clean to be an accident. It is almost the protocol formula printed back at us.

Altair gives timely source, target and head participation weights of **14, 26 and 14**. The current [`get_attestation_participation_flag_indices`](https://github.com/ethereum/consensus-specs/blob/2359a5e3444635ee2fc2acdea8a759e16391af90/specs/altair/beacon-chain.md#get_attestation_participation_flag_indices) logic allows source through five slots and target through 32 slots, but head only when the inclusion delay equals the one-slot minimum. [Electra's attestation processing](https://github.com/ethereum/consensus-specs/blob/2359a5e3444635ee2fc2acdea8a759e16391af90/specs/electra/beacon-chain.md#modified-process_attestation) still feeds those flags into the same proposer-reward numerator.

A normal age-one cohort therefore carries `14 + 26 + 14 = 54` weight. The backlog cohort arrives at age two, so it keeps source and target but loses head: `14 + 26 = 40`. The block after one empty slot has both cohorts, which gives `(54 + 40) / 54 = 1.7407407x` before small participation and balance differences.

I matched every gap-two block to regular blocks from the same UTC day and the same slot position inside the epoch. The observed median ratio was **1.7397035x**. Its 10th-to-90th percentile range was **1.7047x to 1.7756x**, and all 770 blocks had a valid matched baseline.

## The block bodies show the backlog

The reward endpoint says how much the proposer got. The elaborated attestation rows show what it included.

I first joined all **215,226 reward rows** to `canonical_beacon_block FINAL` on exact `(slot, block_root)` and got a 215,226/215,226 match. I then selected the 770 gap-two roots plus one nearby same-day, same-epoch-position regular control for each case. After exact-root deduplication that left 769 unique controls, because one control was nearest to two cases. Those roots were passed as literal lists one UTC day at a time, keeping the raw query on its time key rather than forcing one giant distributed join.

```python
roots_sql = ",".join(f"'{root}'" for root in exact_roots_for_day)

rows = clickhouse.query("clickhouse-raw", f"""
SELECT
  a.block_slot AS inclusion_slot,
  a.block_root,
  count() AS attestation_objects,
  sum(toUInt64(length(a.validators))) AS validator_positions,
  sumIf(
    toUInt64(length(a.validators)),
    a.block_slot - a.slot = 1
  ) AS positions_age_1,
  sumIf(
    toUInt64(length(a.validators)),
    a.block_slot - a.slot = 2
  ) AS positions_age_2,
  sumIf(
    toUInt64(length(a.validators)),
    a.block_slot - a.slot >= 3
  ) AS positions_age_3plus
FROM default.canonical_beacon_elaborated_attestation AS a FINAL
WHERE a.meta_network_name = 'mainnet'
  AND a.slot_start_date_time >= toDateTime('{lookback_start}')
  AND a.slot_start_date_time <  toDateTime('{day_end}')
  AND a.block_slot_start_date_time >= toDateTime('{day_start}')
  AND a.block_slot_start_date_time <  toDateTime('{day_end}')
  AND a.block_root IN ({roots_sql})
GROUP BY a.block_slot, a.block_root
ORDER BY a.block_slot
""")
```

The raw cohort had one aggregate row for every selected exact root. Regular controls contained a median **27,943 validator positions**, including 27,778 at age one and only one at age two. Gap-two blocks contained a median **55,761 positions**: roughly **27,761 at age one and 27,719 at age two**. Separate medians need not add perfectly, which is why the age labels in the chart are rounded.

These are validator positions inside elaborated attestation objects, not unique validators, votes across the network, or a count of attestation messages on gossip. The useful part is the paired shape. One ordinary cohort becomes two almost equal cohorts exactly when the canonical block gap opens from one slot to two.

An empty slot is not only a hole in the block count. It pushes one set of attestation work and about **0.0359 ETH** of proposer reward forward by 12 seconds. The next block does not get a 2x jackpot because the backlog is old enough to lose the head flag; it gets almost exactly the **94/54** that the spec says it should.
