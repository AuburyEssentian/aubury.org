---
slug: validator-table-graveyard
title: The validator table has a graveyard attached
description: In the latest mainnet canonical_beacon_validators snapshot, 1.41M of 2.30M validator indices were withdrawal_done rows with zero balance. A complete UTC day repeats that full snapshot about 225 times.
authors: aubury
tags: [ethereum, validators, xatu, panda, data]
date: 2026-07-02
---

`canonical_beacon_validators` looks like the obvious table to count validators. It is, but only after you pick one epoch. If you skip that step, you can manufacture half a billion validator rows in a day.

<!-- truncate -->

<img src="/img/validator-table-graveyard.png" alt="Two-panel chart showing that withdrawal_done rows dominate the latest raw validator snapshot but sum to zero ETH, while active_ongoing rows hold almost all balance" loading="eager" />

The table name is not wrong. The table is doing exactly what the Beacon API state says: one validator-state row per validator index per epoch. The trap is that most Ethereum validator indices are not active anymore, and the raw table keeps reporting them as state. I started with one epoch, not a day:

```sql
WITH latest AS (
  SELECT max(epoch) AS epoch
  FROM default.canonical_beacon_validators
  WHERE meta_network_name = 'mainnet'
)
SELECT
  epoch,
  min(epoch_start_date_time) AS epoch_time,
  status,
  count() AS rows,
  uniqExact(index) AS validator_indices,
  countIf(isNull(balance)) AS null_balance,
  round(sum(coalesce(balance, 0)) / 1e9, 3) AS sum_balance_eth,
  round(sum(coalesce(effective_balance, 0)) / 1e9, 3) AS sum_effective_eth
FROM default.canonical_beacon_validators
WHERE meta_network_name = 'mainnet'
  AND epoch = (SELECT epoch FROM latest)
GROUP BY epoch, status
ORDER BY rows DESC
```

Epoch `458724`, at `2026-07-02 06:33:59 UTC`, had **2,303,925** rows. **1,413,812** of them were `withdrawal_done`. They had **0 ETH** of balance and **0 ETH** of effective balance. The active set was smaller by row count, **882,107** `active_ongoing` indices, but it carried **40.132M ETH** of balance.

That is the graveyard. It is not a duplicate-row bug either. Grouping that same latest epoch by `index` returned **2,303,925** validator indices, **2,303,925** one-row indices, and **0** multi-row indices. One epoch is clean. The mistake is counting many epochs and pretending the repeated snapshots are new validators.

A complete UTC day makes the failure mode painfully obvious:

```sql
SELECT
  toDate(epoch_start_date_time) AS day,
  count() AS rows,
  uniqExact(epoch) AS epochs,
  uniqExact(index) AS validators,
  round(count() / uniqExact(index), 2) AS rows_per_validator,
  countIf(status = 'withdrawal_done') AS withdrawal_done_rows,
  uniqExactIf(index, status = 'withdrawal_done') AS withdrawal_done_validators,
  round(sumIf(coalesce(balance, 0), status = 'withdrawal_done') / 1e9, 3) AS withdrawal_done_balance_eth
FROM default.canonical_beacon_validators
WHERE meta_network_name = 'mainnet'
  AND epoch_start_date_time >= toDateTime('2026-06-25 00:00:00')
  AND epoch_start_date_time < toDateTime('2026-07-02 00:00:00')
GROUP BY day
ORDER BY day
```

On **2026-07-01**, the raw table had **518,357,830** rows across **225** epochs and **2,303,917** validator indices. That is **224.99 rows per validator**, not 518 million validators. The `withdrawal_done` bucket alone contributed **317,991,170** rows for **1,413,597** validator indices, with **0 ETH** of balance.

For a second path, I used the refined daily table. It says the same thing without making you carry every epoch snapshot around:

```sql
SELECT
  day_start_date,
  status,
  count() AS rows,
  uniqExact(validator_index) AS validator_indices,
  round(sum(coalesce(end_balance, 0)) / 1e9, 3) AS sum_end_balance_eth,
  round(sum(coalesce(effective_balance, 0)) / 1e9, 3) AS sum_effective_eth
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date = toDate('2026-07-01')
GROUP BY day_start_date, status
ORDER BY rows DESC
```

That cross-check returned **1,413,594** `withdrawal_done` rows with **0 ETH**, and **882,128** `active_ongoing` rows with **40.124M ETH** of end balance. The tiny difference from the live raw snapshot is just the chain moving between July 1 end-of-day and the July 2 epoch I sampled.

Small unit note because this table is easy to misuse: `balance` and `effective_balance` are gwei. I divide by `1e9` in the queries above. The zeroes are not rounded-away dust; the `withdrawal_done` rows in the latest snapshot had `min(balance) = 0` and `max(balance) = 0`.

The rule I am taking from this is boring but important: use `canonical_beacon_validators` after you have resolved the epoch you mean. If you want a daily validator balance/status surface, use `mainnet.fct_validator_balance_daily FINAL`. If you sort raw rows by day, you are mostly sorting the graveyard 225 times.

The table is useful. The denominator bites.
