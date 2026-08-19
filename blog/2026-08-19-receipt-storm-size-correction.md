---
slug: receipt-storm-size-correction
title: "Correction: the receipt storm's total was impossible"
description: "A March post put one month of receipt data above its own all-history total. The repaired xatu-cbt model gives 42.19 GB for December and 1.315 TB through March 7, all as logical RLP bytes rather than node disk usage."
authors: aubury
tags: [ethereum, corrections, receipts, logs, xatu]
date: 2026-08-19
---

My March post about Ethereum's [December receipt storm](/blog/receipt-storm/) contained a dead giveaway. It said all tracked receipt history weighed **55.5 GB**, then put December alone at **61.4 GB**. One month cannot be larger than all history. I should have stopped there.

The underlying xatu-cbt receipt models were later repaired and re-backfilled. With the same fixed dates, December now comes to **42.19 GB of logical receipt RLP**, not 61.4 GB. The model sums to **1.315 TB from August 8, 2015 through March 7, 2026**, not 55.5 GB, and neither number is a measurement of node disk usage.

<!-- truncate -->

<img src="/img/receipt-storm-size-correction.png" alt="Dark correction chart showing that the published December 2025 receipt total of 61.4 GB exceeded the published all-history claim of 55.5 GB. Grouped bars compare the published and corrected November, December, and January totals. A final card shows 1,315.3 GB of logical receipt RLP through March 7, 2026, explicitly labelled as not node disk usage." loading="eager" />

## The contradiction was already in the post

The old article ran this monthly reduction over `mainnet.fct_execution_receipt_size_daily`:

```sql
SELECT
  toStartOfMonth(day_start_date) AS month,
  round(avg(avg_log_count_per_transaction), 3) AS avg_logs_per_tx,
  round(sum(total_receipt_bytes) / 1e9, 1) AS total_receipts_gb
FROM mainnet.fct_execution_receipt_size_daily FINAL
WHERE day_start_date >= toDate('2025-11-01')
  AND day_start_date <  toDate('2026-02-01')
GROUP BY month
ORDER BY month;
```

The March snapshot produced 37.2 GB for November, 61.4 GB for December, and 50.8 GB for January. It also produced the 55.5 GB cumulative headline. I published both without checking the obvious subset-versus-total identity.

Rerunning that exact SQL against today's `FINAL` view gives 27.4 GB, 42.2 GB, and 37.8 GB. The old snapshot is no longer reproducible because the transformation chain changed underneath it.

| Month | March post | Current `FINAL` |
|---|---:|---:|
| November 2025 | 37.2 GB | 27.4 GB |
| December 2025 | 61.4 GB | 42.2 GB |
| January 2026 | 50.8 GB | 37.8 GB |

## The model had a shard-grain bug

This was not a harmless rounding change. The receipt path starts with canonical transaction and log rows, builds one RLP-size row per transaction, aggregates those rows by block, and then rolls blocks into hourly and daily tables.

In May, xatu-cbt changed the receipt joins from local to [`GLOBAL`](https://github.com/ethpandaops/xatu-cbt/commit/94a1abbd07218ca58c07fb607cfcb000b5c5baf3). Two days later, [PR #254](https://github.com/ethpandaops/xatu-cbt/pull/254) documented the deeper problem: transaction rows were sharded by `(block_number, transaction_hash)` even though the next model aggregated only by block. On a multi-shard cluster, one block could leave several partial aggregates that `ReplacingMergeTree FINAL` would never merge back together.

The fix co-located every transaction from a block on the same shard. Its rebuild list explicitly included `int_transaction_receipt_size`, `int_block_receipt_size`, and both receipt-size rollups. That is why today's table can answer the old query while returning different history.

## The corrected total

I also changed the monthly log ratio from an unweighted average of daily ratios to `total logs / total transactions`. It barely moves December, but this is the right denominator and the bounds are now literal:

```sql
SELECT
  toStartOfMonth(d.day_start_date) AS month,
  sum(d.total_receipt_bytes) AS month_receipt_bytes,
  sum(d.total_log_count) AS month_logs,
  sum(d.transaction_count) AS month_transactions,
  sum(d.total_log_count) / sum(d.transaction_count) AS logs_per_transaction
FROM mainnet.fct_execution_receipt_size_daily AS d FINAL
WHERE d.day_start_date >= toDate('2025-11-01')
  AND d.day_start_date <  toDate('2026-02-01')
GROUP BY month
ORDER BY month;
```

December contains **42,187,881,374 receipt bytes**, **187,172,700 logs**, and **34,872,509 transactions**, or **5.367 logs per transaction**. November contains 27,353,203,103 bytes. The corrected December excess is therefore **14.835 GB**, a **54.2%** increase over November. The old post claimed 24.2 GB and 65%.

For the all-history check, I froze the original article's March 8 cutoff and compared the explicit sum with the model's endpoint cumulative field:

```sql
SELECT
  min(day_start_date) AS first_day,
  max(day_start_date) AS last_day,
  count() AS complete_days,
  sum(total_receipt_bytes) AS summed_receipt_bytes,
  argMax(cumulative_receipt_bytes, day_start_date)
    AS endpoint_cumulative_receipt_bytes
FROM mainnet.fct_execution_receipt_size_daily FINAL
WHERE day_start_date < toDate('2026-03-08');
```

Both paths return **1,315,329,854,248 bytes** across 3,865 complete days, from August 8, 2015 through March 7, 2026. That is **1,315.3 decimal GB**, 23.7 times the published 55.5 GB. The current view is a near-genesis backfill, not the 430-day partial surface I described in March.

I checked December one level down as well. The canonical timestamp index fixes the month at blocks **23,914,921 through 24,136,052**. Summing `receipt_bytes` from `int_block_receipt_size FINAL` over those literal bounds returns the same 42,187,881,374 bytes. The hourly model also lands on the same byte, transaction, and log totals across all 744 hours. The block table has fewer rows because empty canonical blocks have no transaction-receipt row; the daily rollup keeps those blocks with zero receipt bytes.

## The storm itself survives

The byte totals changed. The ugly December 7 workload did not disappear.

I reran the two raw grain checks separately over blocks 23,957,251 through 23,964,385:

```sql
SELECT
  count() AS raw_rows,
  uniqExact((block_number, transaction_hash, internal_index)) AS log_keys,
  uniqExact(transaction_hash) AS transactions_with_logs
FROM default.canonical_execution_logs FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 23957251 AND 23964385;

SELECT
  count() AS raw_rows,
  uniqExact(transaction_hash) AS transactions
FROM default.canonical_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 23957251 AND 23964385;
```

The log table has **19,295,205 rows and 19,295,205 unique log keys**. The transaction table has **1,124,281 rows and 1,124,281 unique hashes**. That is still **17.162 logs per transaction** across the day, and the corrected receipt model assigns it **3.547 GB** of logical RLP. December 7 alone supplied 8.4% of the month's receipt bytes.

So the narrow mechanism in the first post holds: batch contracts emitted a ridiculous number of logs, and those logs made receipts much larger. I am not retracting the storm.

I am retracting the storage claim. `receipt_bytes` is the size of the protocol's RLP-encoded receipt representation, reconstructed from transaction status, cumulative gas, the 256-byte bloom, and logs. It is not a direct reading of RocksDB, Pebble, freezer files, compression, indexes, or pruning behavior in any execution client. The original estimate of permanent node-storage cost took a logical serialized size, called it physical disk use, and multiplied it across nodes. The data never supported that externality calculation.

The corrected conclusion is less dramatic and more defensible: December 2025 added **14.8 GB more logical receipt RLP than November** in the repaired model, and one bot-heavy day explains a visible chunk of the jump. What that cost on disk depends on the client and its storage policy. I did not measure it.
