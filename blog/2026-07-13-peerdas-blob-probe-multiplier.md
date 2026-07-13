---
slug: peerdas-blob-probe-multiplier
title: "One PeerDAS column observation can become 21 probe_count units"
description: "Over 14 complete days, Xatu's blob-level PeerDAS availability table turned 63.60M slot-column observation units into 335.65M probe_count units by repeating each column result once per blob."
authors: [aubury]
tags: [ethereum, peerdas, data-availability, xatu, data]
date: 2026-07-13T15:25:47+10:00
---

`mainnet.fct_data_column_availability_by_slot_blob` has both `blob_index` and `probe_count`, which makes summing the latter feel safe. It is not. Across 14 complete UTC days, the source slot/column table held **63,597,380 observation units**; the blob-level table summed to **335,651,250 `probe_count` units** because it copied each column result once for every blob in the slot.

<!-- truncate -->

This is the other axis of [the PeerDAS commitment-list trap](/blog/data-column-sidecar-commitments/) I looked at last week. A data column sidecar contains the cell at one column index from every blob row in the block. It makes sense to represent that column's availability against every blob, but those blob rows still came from the same column observation.

The transformation is refreshingly blunt. It reads `fct_data_column_availability_by_slot`, then uses an [`ARRAY JOIN`](https://github.com/ethpandaops/xatu-cbt/blob/ed839f47f9165d057e3e90fb10f2ad09979918aa/models/transformations/fct_data_column_availability_by_slot_blob.sql#L46-L74) to manufacture one `blob_index` row for every blob:

```sql
FROM mainnet.fct_data_column_availability_by_slot FINAL
WHERE slot_start_date_time BETWEEN <task start> AND <task end>
ARRAY JOIN range(toUInt16(blob_count)) AS blob_index
```

PeerDAS has 128 columns. Each [`DataColumnSidecar`](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/fulu/das-core.md#datacolumnsidecar) carries one `column` list whose length matches the block's `kzg_commitments` list, so the column contains one cell from each blob. In a 21-blob block, one observed column is valid evidence for all 21 blobs. The refined table expresses that by making 21 rows with the same counts, latency percentiles and availability percentage.

I started from the unexpanded table so the source denominator stayed visible:

```sql
SELECT
  count() AS slot_column_rows,
  uniqExact(slot) AS slots,
  sum(probe_count) AS probe_units,
  sum(success_count) AS success_units,
  sum(failure_count) AS failure_units,
  sum(missing_count) AS missing_units,
  sum(custody_probe_count) AS custody_probe_units,
  sum(gossipsub_count) AS gossipsub_units
FROM mainnet.fct_data_column_availability_by_slot FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-28 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-12 00:00:00');
```

That returned **9,623,424 slot/column rows** over **75,183 slots** and **63,597,380 `probe_count` units**. As [the earlier availability post](/blog/data-column-availability-gossip/) warned, these are not all active RPC probes: **63,595,628** came from passive gossipsub observations and only **1,752** from the refined custody-probe path.

Then I collapsed the blob table back to `(slot, column_index)` and checked every expanded key. This is the query behind the headline number:

```sql
SELECT
  count() AS slot_column_keys,
  sum(key_blob_rows) AS blob_column_rows,
  countIf(key_blob_rows != key_blob_count) AS row_count_errors,
  countIf(
    key_index_count != key_blob_count
    OR key_min_index != 0
    OR key_max_index + 1 != key_blob_count
  ) AS index_set_errors,
  countIf(key_metric_variants != 1) AS metric_variant_errors,
  sum(key_probe_count) AS deduped_probe_units,
  sum(key_probe_count * key_blob_rows) AS expanded_probe_units,
  round(expanded_probe_units / deduped_probe_units, 6) AS repeat_factor
FROM (
  SELECT
    slot,
    column_index,
    count() AS key_blob_rows,
    any(blob_count) AS key_blob_count,
    uniqExact(blob_index) AS key_index_count,
    min(blob_index) AS key_min_index,
    max(blob_index) AS key_max_index,
    uniqExact(tuple(
      probe_count, success_count, failure_count, missing_count,
      availability_pct, min_response_time_ms, p50_response_time_ms,
      p95_response_time_ms, p99_response_time_ms, max_response_time_ms,
      unique_peer_count, unique_client_count, unique_implementation_count
    )) AS key_metric_variants,
    any(probe_count) AS key_probe_count
  FROM mainnet.fct_data_column_availability_by_slot_blob FINAL
  WHERE slot_start_date_time >= toDateTime('2026-06-28 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-12 00:00:00')
  GROUP BY slot, column_index
);
```

All **9,623,424** slot/column keys passed. Each key had exactly `blob_count` rows, the blob indices ran from zero through `blob_count - 1`, and the aggregate metrics were identical across those rows. The expansion produced **50,770,816 blob/column rows** and repeated the 63.60M source units into **335.65M**, an overall factor of **5.277753x**. Bucketed by `blob_count`, the ratio was exactly 1x, 2x, 3x and so on through 21x.

<a href="/img/peerdas-blob-probe-multiplier.png?v=20260713-1525" target="_blank" rel="noopener noreferrer">
  <img src="/img/peerdas-blob-probe-multiplier.png?v=20260713-1525" alt="Two horizontal bars compare 63.6 million source slot-by-column observation units with 335.7 million probe_count units after blob-level expansion, 5.28 times the source total." loading="eager" />
</a>

<small><a href="/img/peerdas-blob-probe-multiplier.png?v=20260713-1525" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a></small>

The daily multiplier moved between **4.33x and 6.52x** because the blob-count mix moved. This is not duplicate ingestion. It is the intended row grain doing exactly what the SQL asks, which is why a plain `sum(probe_count)` is such an easy mistake.

I checked the source scale against raw gossipsub rows rather than trusting two refined tables. With both event time and target slot bounded, the raw table had **63,786,240 rows** over the same 75,183 slots:

```sql
SELECT
  count() AS raw_rows,
  uniqExact(tuple(slot, column_index)) AS slot_column_keys,
  uniqExact(slot) AS slots
FROM default.libp2p_gossipsub_data_column_sidecar FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-28 00:00:00')
  AND event_date_time <  toDateTime('2026-07-13 00:00:00')
  AND slot_start_date_time >= toDateTime('2026-06-28 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-12 00:00:00');
```

That raw count was 0.30% above the refined table's 63,595,628 gossipsub units. I kept the refined totals for the exact transformation comparison instead of averaging away the difference.

Use `fct_data_column_availability_by_slot` when the question is how many underlying slot/column observation units the model counted. Use the blob-level table when the question really needs a blob index. Just do not sum its repeated `probe_count`, success counts, latency summaries or unique-count columns and rename the result "probes." A 21-blob slot can make one column observation look like 21 of them without a single extra source observation.
