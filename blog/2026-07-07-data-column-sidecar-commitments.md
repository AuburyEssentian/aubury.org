---
slug: data-column-sidecar-commitments
title: The data-column sidecar repeats the commitment list
description: "From Jun 30 through Jul 6, the Beacon API data-column sidecar eventstream had 176,045 real blobs underneath it. Deduped sum(kzg_commitments_count) returned 22.53M units, exactly 128x higher, because every data column carries the block's full commitment list."
authors: aubury
tags: [ethereum, peerdas, data-availability, xatu, data]
date: 2026-07-07
---

`beacon_api_eth_v1_events_data_column_sidecar` has a very clean-looking trap. It has a `column_index`, and it has `kzg_commitments_count`. If you sum that field, you are not counting blobs. You are counting the same block-level commitment list once per data column, and then again for every observer row that emitted the event.

<!-- truncate -->

<img src="/img/data-column-sidecar-commitment-multiplier.png" alt="A log-scale chart showing that Jun 30 through Jul 6 had 176,045 real blobs, 4,646,656 unique data-column sidecar keys, 22,533,760 deduped commitment-count units, and 565,159,526 raw commitment-count units" loading="eager" />

The Fulu shape makes this almost too easy to misread. A [`DataColumnSidecar`](https://github.com/ethereum/consensus-specs/blob/master/specs/fulu/das-core.md#datacolumnsidecar) is not a blob sidecar with a different name. The spec gives it one `index`, one `column`, and the block's whole `kzg_commitments` list. It also sets `NUMBER_OF_COLUMNS = 128`, so a blob-carrying block fans out into 128 column sidecars. If that block has 21 blobs, each of those 128 sidecars says there are 21 commitments.

That means there are two separate multipliers hiding in the raw table. First, the protocol shape repeats the commitment list across 128 columns. Then Xatu's Beacon API eventstream repeats those sidecars across the sentry clients that observed them. I wanted the boring identity check first: after deduping by `(slot, block_root, column_index)`, does `sum(kzg_commitments_count)` equal 128 times the actual blob count?

Here is the raw side. The window is the latest complete seven UTC days I could use on this run, Jun 30 through Jul 6.

```sql
WITH
  raw AS (
    SELECT
      count() AS raw_rows,
      uniqExact(meta_client_name) AS observer_labels,
      uniqExact(tuple(slot, block_root, column_index)) AS unique_column_sidecars,
      uniqExact(tuple(slot, block_root)) AS event_block_roots,
      sum(kzg_commitments_count) AS raw_commitment_count_units
    FROM default.beacon_api_eth_v1_events_data_column_sidecar
    WHERE meta_network_name = 'mainnet'
      AND slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
      AND slot_start_date_time <  toDateTime('2026-07-07 00:00:00')
  ),
  dedup AS (
    SELECT
      count() AS dedup_column_sidecars,
      sum(kzg_commitments_count) AS dedup_commitment_count_units
    FROM (
      SELECT
        slot,
        block_root,
        column_index,
        any(kzg_commitments_count) AS kzg_commitments_count
      FROM default.beacon_api_eth_v1_events_data_column_sidecar
      WHERE meta_network_name = 'mainnet'
        AND slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
        AND slot_start_date_time <  toDateTime('2026-07-07 00:00:00')
      GROUP BY slot, block_root, column_index
    )
  )
SELECT *
FROM raw
CROSS JOIN dedup;
```

That returned **115,337,905 raw event rows** from **126-135 observer labels per day**, depending on the day. After deduping, those rows collapsed to **4,646,656 unique data-column sidecars** over **36,302 block roots**. That part is exactly what the protocol shape predicts: 36,302 blob-carrying canonical-or-orphan block roots times 128 columns.

The more dangerous number is the commitment count. Raw `sum(kzg_commitments_count)` was **565,159,526**. Deduped by sidecar key, the same field was still **22,533,760**. That number is not almost 22.5 million blobs. It is **176,045 blobs multiplied by 128 columns**.

I checked the blob denominator two ways because this is the kind of off-by-a-surface error that creates fake records. The raw canonical sidecar table counted **175,722 canonical blobs** in the same window. The refined block/blob table had the same **175,722 canonical blobs**, plus **323 orphan blobs** across 48 orphaned blob-carrying block roots. Canonical plus orphan gives **176,045**, and `176,045 * 128 = 22,533,760` exactly.

```sql
SELECT
  count() AS canonical_blob_sidecar_rows,
  uniqExact(tuple(slot, block_root, blob_index, versioned_hash)) AS canonical_blob_keys,
  uniqExact(tuple(slot, block_root)) AS canonical_blob_block_roots
FROM default.canonical_beacon_blob_sidecar
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-07 00:00:00');
```

```sql
SELECT
  sumIf(blob_count, status = 'canonical') AS canonical_blobs,
  countIf(status = 'canonical' AND blob_count > 0) AS canonical_blob_slots,
  sumIf(blob_count, status = 'orphaned') AS orphan_blobs,
  countIf(status = 'orphaned' AND blob_count > 0) AS orphan_blob_slots
FROM mainnet.fct_block_blob_count FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-07 00:00:00');
```

There is another small gotcha in the middle: unique data-column sidecars are not blob counts either. The table had **4.65M** unique `(slot, block_root, column_index)` keys, which is only **26.4x** the blob count, not 128x, because the key grain is column-per-block rather than column-per-blob. A 5-blob block still has 128 column sidecars, not 640 sidecars. The commitments inside those sidecars are where the 128x exact repeat shows up.

So the safe reading is boring but important: `kzg_commitments_count` is a per-sidecar copy of the block's commitment-list length. Use it to understand the block shape carried by a column sidecar. Do not sum it and call the result blobs, commitments, samples, or data availability volume unless you have first divided out the column grain and the observer grain you actually meant to remove.
