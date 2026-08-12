---
slug: march2-finality-loss-correction
title: "Ethereum did not lose finality on March 2"
description: "A distributed ClickHouse join mislabelled ordinary mainnet slots as orphans. Corrected data shows 0.33% peak hourly orphaning, 99.10% minimum participation, and uninterrupted finality."
authors: [aubury]
tags: [ethereum, consensus, finality, correction, xatu, data]
date: 2026-08-13
---

In March I wrote that Ethereum lost finality for roughly two and a half hours. It did not. The query behind that post mislabelled ordinary canonical blocks as orphans because a non-`GLOBAL` join ran against distributed ClickHouse tables.

The corrected March 2 peak is **0.33% orphaning**, not **68.5%**. Minimum canonical attestation participation was **99.10%**, not 0%. The finalized checkpoint stayed exactly two epochs behind throughout the claimed incident, which is normal.

<!-- truncate -->

<figure>
  <a href="/img/march2-finality-loss-correction.png">
    <img src="/img/march2-finality-loss-correction.png" alt="Correction chart comparing published and corrected orphan-rate peaks for February 24, February 26 to 27, and March 2, with minimum attestation participation and finality lag." loading="eager" />
  </a>
</figure>

This also retracts the two "self-healing network splits" I reported on February 24 and February 26-27. Their corrected peak hourly orphan rates are **0.67%** and **0.67%**, not 63% and 78%. All three incidents were artifacts from the same model path.

## The join that made the incidents

The refined proposer model starts with one proposer-duty row per slot and attaches the canonical block for that slot. Later it attaches a block observed at head and labels the result:

```sql
CASE
  WHEN c.block_root IS NOT NULL THEN 'canonical'
  WHEN h.block_root IS NOT NULL THEN 'orphaned'
  ELSE 'missed'
END AS status
FROM canonical c
LEFT JOIN head_blocks h ON c.slot = h.slot
```

Both sides were distributed tables. A normal distributed join does not automatically send every row from the right side to every shard evaluating the left side. When a canonical block landed on a different shard from its proposer duty, `c.block_root` could look null inside the model. If the head side had a root, the slot became "orphaned" even though the canonical block existed.

The xatu-cbt fix was pleasingly small: change that to `GLOBAL LEFT JOIN`. The [May 30 correction commit](https://github.com/ethpandaops/xatu-cbt/commit/94a1abbd07218ca58c07fb607cfcb000b5c5baf3) made the same distributed-join repair across 48 model files, including `fct_block_proposer` and its upstream full outer join.

That is why this took months to become obvious. The old numbers had the shape of an incident, complete with a peak and recovery. The shape came from where matching rows happened to live, not from Ethereum.

## March 2, rebuilt

The current corrected proposer table has exactly **300 slots in each hour** from 10:00 through 13:59 UTC. It reports two orphaned slots over the four hours:

| Hour (UTC) | Canonical | Orphaned | Missed | Orphan rate |
| --- | ---: | ---: | ---: | ---: |
| 10:00 | 299 | 0 | 1 | 0.000% |
| 11:00 | 297 | 1 | 2 | 0.333% |
| 12:00 | 299 | 1 | 0 | 0.333% |
| 13:00 | 298 | 0 | 2 | 0.000% |

```sql
SELECT
  toStartOfHour(slot_start_date_time) AS hour,
  countIf(status = 'canonical') AS canonical,
  countIf(status = 'orphaned') AS orphaned,
  countIf(status = 'missed') AS missed,
  count() AS slots,
  round(100.0 * orphaned / slots, 3) AS orphan_pct
FROM mainnet.fct_block_proposer_by_validator FINAL
WHERE slot_start_date_time >= toDateTime('2026-03-02 10:00:00')
  AND slot_start_date_time <  toDateTime('2026-03-02 14:00:00')
GROUP BY hour
ORDER BY hour;
```

Raw canonical tables give the same slot accounting. `canonical_beacon_proposer_duty FINAL` has **1,200** distinct duties in the window; `canonical_beacon_block FINAL` has **1,193** distinct canonical block slots. A local/full join on `slot` therefore leaves seven genuine no-block slots, exactly the corrected table's two orphaned plus five missed. The refined block table independently contains two orphan block roots in those hours.

The participation series is just as ordinary:

| Hour (UTC) | Average participation | Minimum slot participation |
| --- | ---: | ---: |
| 10:00 | 99.8344% | 99.5456% |
| 11:00 | 99.8357% | 99.1012% |
| 12:00 | 99.8456% | 99.3952% |
| 13:00 | 99.8513% | 99.2816% |

My old claim of a zero-participation epoch was not a subtle denominator disagreement. It was wrong by about 99 percentage points.

## Finality did not blink

The canonical state checkpoint table contains every epoch from **431300 through 431340**, spanning the claimed disruption. For all 41 rows, `epoch - finalized_epoch` equals two. There is no delayed checkpoint:

```sql
SELECT
  count() AS rows,
  uniqExact(epoch) AS epochs,
  min(epoch - finalized_epoch) AS min_lag,
  max(epoch - finalized_epoch) AS max_lag,
  countIf(epoch - finalized_epoch > 2) AS delayed_rows
FROM canonical_beacon_state_finality_checkpoint FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch BETWEEN 431300 AND 431340;

-- rows: 41, epochs: 41, min_lag: 2, max_lag: 2, delayed_rows: 0
```

I cross-checked that against the raw `finalized_checkpoint` eventstream. It contains all 41 consecutive finalized epochs, **5,118 event rows from 126 observers**, and zero `execution_optimistic` rows. For the state-table checkpoints, I also derived each finalized checkpoint block root from the last canonical block at or before `finalized_epoch * 32`; all **66 of 66** rows in the wider 08:00-15:00 window matched.

That is enough to retract the incident, not merely soften it. There was no three-hour finality loss, no epoch with zero canonical participation, no entity-wide fork, and no escalating sequence of February network splits.

## One March result survives

The timing cliff from the earlier orphan post still reproduces after the model fix. Over the 30 complete days from February 1 through March 2, the corrected data has **390 unique orphan block roots**. Matching those roots to first-seen gossip timing still shows the sharp transition:

| Earliest observed block time | Blocks | Orphaned | Orphan rate |
| --- | ---: | ---: | ---: |
| 3.4-3.6s | 1,195 | 8 | 0.67% |
| 3.6-3.8s | 379 | 22 | 5.80% |
| 3.8-4.0s | 129 | 60 | 46.51% |
| 4.0-4.2s | 73 | 55 | 75.34% |

That part joins on exact block root and still has the same mechanism-level shape. What does not survive is the old headline total of 1,783 orphans, the two February split narratives, or the claim that those incidents made up 58% of the month's orphans.

The lesson here is uglier than "check your query." Distributed joins can return a coherent story with plausible timestamps, entity splits, and recovery curves. If the missing side of a join decides whether a row is canonical or orphaned, prove the join preserves every semantic key before diagnosing the network from its output.
