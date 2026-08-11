---
slug: sync-committee-ghost-query-correction
title: "The sync ghost query divided misses by misses"
description: "A correction to Sync Committee Ghosts: ARRAY JOIN made every candidate look 100% absent. The fixed query found 17 complete misses across 25 full periods, and one selected validator had already exited."
authors: aubury
tags: [ethereum, consensus, sync-committee, correction, xatu]
date: 2026-08-12
---

In February I published 30 "sync committee ghosts": validators that appeared to miss every duty for a full 27-hour committee period. The result looked clean. The SQL was not.

`ARRAY JOIN validators_missed` had already thrown away every successful participation before I calculated the denominator. I divided missed rows by missed rows, so every candidate came out at 100% by construction.

<!-- truncate -->

This is a correction to [Sync Committee Ghosts](/blog/sync-committee-ghosts/). The old query did catch a real offline cohort, but it overstated the count and the number of affected periods. It also treated one validator as active even though it had already exited.

## The denominator disappeared

The broken part of the old query is short enough to see once you know where to look:

```sql
SELECT
  intDiv(epoch, 256) AS period,
  validator_index,
  count() AS total_blocks,
  countIf(has(validators_missed, validator_index)) AS missed,
  round(100.0 * missed / total_blocks, 2) AS miss_rate
FROM canonical_beacon_block_sync_aggregate
ARRAY JOIN validators_missed AS validator_index
GROUP BY period, validator_index
HAVING total_blocks > 4000 AND miss_rate > 80
```

`ARRAY JOIN validators_missed` expands one row for each missed committee position. After that expansion, `total_blocks` is not total blocks or total selected positions. It is the number of missed positions. The `countIf` then asks whether the validator taken from `validators_missed` is present in `validators_missed`. It always is.

I froze the old rolling window to the post's commit time, from `2026-01-29 00:51:33` through `2026-02-28 00:51:33` UTC. That reproduces 30 candidate rows, which is why the original result looked stable. Those were period-validator rows rather than 30 distinct validator keys, and two edge periods were only partly covered by the 30-day window.

A claim about an entire committee period needs entire periods. The fixed audit therefore uses periods 1657 through 1681: 25 complete periods and 29 of the old candidate rows.

## Put both arrays back

The raw table already contains the missing denominator. Each canonical block row splits the 512 committee positions into `validators_participated` and `validators_missed`. The corrected query expands both arrays, marks the participated side as 1 and the missed side as 0, then aggregates at period-validator grain:

```sql
WITH member_positions AS (
  SELECT
    intDiv(epoch, 256) AS period,
    slot,
    arrayJoin(validators_participated) AS validator_index,
    toUInt8(1) AS participated
  FROM canonical_beacon_block_sync_aggregate
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-01-29 00:51:33')
    AND slot_start_date_time <  toDateTime('2026-02-28 00:51:33')
    AND intDiv(epoch, 256) BETWEEN 1657 AND 1681

  UNION ALL

  SELECT
    intDiv(epoch, 256) AS period,
    slot,
    arrayJoin(validators_missed) AS validator_index,
    toUInt8(0) AS participated
  FROM canonical_beacon_block_sync_aggregate
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-01-29 00:51:33')
    AND slot_start_date_time <  toDateTime('2026-02-28 00:51:33')
    AND intDiv(epoch, 256) BETWEEN 1657 AND 1681
), by_validator AS (
  SELECT
    period,
    validator_index,
    count() AS selected_positions,
    sum(participated) AS participated_positions
  FROM member_positions
  GROUP BY period, validator_index
)
SELECT
  period,
  validator_index,
  selected_positions,
  participated_positions,
  round(1 - participated_positions / selected_positions, 6) AS miss_rate
FROM by_validator
WHERE selected_positions > 4000
ORDER BY miss_rate DESC, period, validator_index
```

The correction is not subtle. Of the 29 candidates in complete periods, 17 missed every recorded canonical sync aggregate. Another six missed between 83.4% and 99.7%. The remaining six were between 56.6% and 75.3%, below the old query's supposed 80% threshold.

Those 17 complete cases appeared in 13 of the 25 full periods. One additional 100% miss sat in the partial final period and is not counted as a full-term ghost.

<img src="/img/sync-committee-ghost-query-correction.png" alt="Correction chart showing that the old query labelled all 29 full-period candidates as complete misses, while the corrected query found 17 complete misses, six mostly missed cases and six below 80 percent. A second panel shows the complete-miss rate falling sharply with validator index." loading="eager" />

There is a grain detail here worth keeping ugly and explicit. `selected_positions` counts validator positions in canonical block sync aggregates. A missed block proposal has no canonical block aggregate to inspect, so "complete" here means no participation in any recorded canonical aggregate during a full committee period. It does not mean 8,192 independently observed signatures.

I checked the raw grain before trusting the result. The window contained 215,294 unique `(slot, block_root)` rows, every row split into exactly 512 positions, and the two arrays did not overlap. I then compared the 23 cases above 80% with `mainnet.fct_sync_committee_participation_by_validator FINAL`. Selected and participated position counts matched for every case.

## The skew survived, with one awkward exception

The original post's cohort story survives. Among unique validators selected in the 25 full periods, 9 of 145 indices below 25,000 were complete misses, or 6.21%. At the other end, 5 of 10,857 indices above 500,000 were complete misses, or 0.046%. That is a 134.8x gap. The two middle bands were 3 of 153 for indices 25,000-100,000 and 0 of 1,146 for indices 100,000-500,000.

That is a cleaner early-index skew than the old 63x headline, but it has a narrower meaning. This is the miss rate among validators selected into these committees, not a failure rate for the whole active set.

I also checked ordinary attestation duties for the 17 corrected complete misses. Sixteen had rows in `fct_attestation_vote_correctness_by_validator`, and all sixteen missed all 256 ordinary attestation duties during the same sync period. Those validators really were offline across both duty types.

The seventeenth explains why "permanently offline but still active" was too neat. Validator 1,941,835 was selected for sync period 1675, but its exit epoch was 428704. At the start of period 1675, epoch 428800, the canonical validator state already marked it `exited_unslashed`; it became withdrawable at epoch 428960 and later moved to `withdrawal_done`.

That can happen because the state carries a current and next sync committee. At a period boundary, the [consensus transition promotes the stored next committee and selects another one ahead](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/altair/beacon-chain.md#process_sync_committee_updates). This validator was active when chosen for the future committee, then exited before its term began. Its absence was real, but it was not evidence of a validator stuck in the active set.

The old query found something true and then inflated it with a denominator that contained no successes. That is the annoying kind of bug: the cohort pattern survives just well enough to make the bad query feel vindicated. The corrected result is 17 complete misses across 13 of 25 full periods, with one of those 17 already exited. Not 30 validators across 22 of 27 periods, and not 30 active ghosts.
