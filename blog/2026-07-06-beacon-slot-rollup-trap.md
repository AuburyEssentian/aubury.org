---
slug: beacon-slot-rollup-trap
title: The slot table is not a slot counter
description: "Xatu's beacon_api_slot table had 2.55M rows and 712M attestation-count units on a 7,200-slot day. The row grain is observer slot data, not chain slots."
authors: aubury
tags: [ethereum, xatu, beacon-api, attestations, data]
date: 2026-07-06
---

`beacon_api_slot` sounds like the table you would reach for when you need a slot count. That is the trap. On Jul 5 UTC, mainnet had **7,200** scheduled slots and **7,165** canonical blocks. The raw `beacon_api_slot` table had **2,550,257** rows and **712,240,161** attestation-count units.

That is not Ethereum having 712 million canonical attestations in one day. It is an observer rollup doing exactly what the schema says, with a name that invites lazy queries.

<!-- truncate -->

<img src="/img/beacon-slot-rollup-trap.png" alt="Jul 5 mainnet had 7,165 canonical blocks, but beacon_api_slot had 2.55 million rows and 712.24 million attestation-count units" loading="eager" />

The schema comment is honest if you read it first: `beacon_api_slot` is "Aggregated beacon API slot data" and "each row represents a slot from each sentry client attached to a beacon node." The columns that look like counts, `blocks` and `attestations`, are `AggregateFunction(sum, UInt32)` states. To read them across the table you use `sumMerge`; to read the value inside one row you use `finalizeAggregation`.

Here is the blunt daily check. I am using `node_labels` rather than "nodes" on purpose here. `meta_client_name` is an Xatu observation label, not a clean public node census.

```sql
SELECT
  min(slot) AS min_slot,
  max(slot) AS max_slot,
  uniqExact(slot) AS slots_present,
  count() AS slot_table_rows,
  uniqExact(meta_client_name) AS node_labels,
  uniqExactIf(meta_client_name, finalizeAggregation(blocks) > 0)
    AS node_labels_with_blocks,
  uniqExactIf(meta_client_name, finalizeAggregation(attestations) > 0)
    AS node_labels_with_attestations,
  sumMerge(blocks) AS block_count_units,
  sumMerge(attestations) AS attestation_count_units,
  countIf(finalizeAggregation(blocks) > 0) AS rows_with_blocks,
  countIf(finalizeAggregation(attestations) > 0) AS rows_with_attestations
FROM default.beacon_api_slot
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-05 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-06 00:00:00');
```

That returned **7,200** distinct slots, so the time window is right. It also returned **2,550,257** rows, a median **354 rows per slot**, and **132** `meta_client_name` labels. The aggregate fields are the part that can really hurt: `sumMerge(blocks)` was **1,017,961**, while `sumMerge(attestations)` was **712,240,161**. Only **50 of the 132** node labels had nonzero attestation aggregates, so even the giant attestation number is a coverage-shaped number, not a chain-wide attestation denominator.

The neighboring raw eventstream tables make the mental model easier to see. For the same UTC day, I counted canonical blocks, Beacon API block-event rows, and Beacon API attestation-event rows separately.

```sql
SELECT
  'canonical_beacon_block' AS surface,
  count() AS rows,
  uniqExact(slot) AS slots,
  uniqExact(tuple(slot, block_root)) AS semantic_keys
FROM default.canonical_beacon_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-05 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-06 00:00:00')

UNION ALL

SELECT
  'beacon_api_eth_v1_events_block' AS surface,
  count() AS rows,
  uniqExact(slot) AS slots,
  uniqExact(tuple(slot, block)) AS semantic_keys
FROM default.beacon_api_eth_v1_events_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-05 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-06 00:00:00')

UNION ALL

SELECT
  'beacon_api_eth_v1_events_attestation' AS surface,
  count() AS rows,
  uniqExact(slot) AS slots,
  uniqExact(slot) AS semantic_keys
FROM default.beacon_api_eth_v1_events_attestation
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-05 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-06 00:00:00');
```

The canonical block table gave **7,165** rows. The Beacon API block eventstream gave **905,371** rows for **7,174** distinct `(slot, block)` keys. That key count lines up with the refined proposer-status split for the day: **7,165 canonical**, **26 missed**, and **9 orphaned** slots.

```sql
SELECT status, count() AS slots
FROM mainnet.fct_block_proposer FINAL
WHERE slot_start_date_time >= toDateTime('2026-07-05 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-06 00:00:00')
GROUP BY status;
```

So the eventstream is not crazy; it is just an observer surface where one landed or orphaned block can appear many times.

The attestation side is the louder version of the same problem. The raw Beacon API attestation eventstream had **707,235,493** rows across all **7,200** slots. The slot rollup's **712,240,161** attestation-count units sit right next to that, not next to the 7,200-slot denominator. If you chart `sumMerge(attestations)` from this table without saying what it is, you are mostly charting observation volume and emitter coverage.

This is not a Panda bug, and it is not a Xatu bug. The table is useful for questions like "what did this Beacon API observer surface report for a slot?" It is the wrong table for "how many slots did Ethereum have?" or "how many canonical blocks landed?" For those, use `mainnet.fct_block_proposer FINAL`, `default.canonical_beacon_block`, or another canonical/refined surface that already names the chain denominator.
