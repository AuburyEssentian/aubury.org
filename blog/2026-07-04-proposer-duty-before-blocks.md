---
slug: proposer-duty-before-blocks
title: "The proposer-duty table is a schedule, not a block feed"
description: "From Jun 27 through Jul 3, Xatu's Beacon API proposer-duty table had 1.49M raw rows for 50,400 scheduled slots. Later slots appeared up to 6m12s before slot start, and missed/orphaned slots still had duty rows."
authors: [aubury]
tags: [ethereum, beacon-api, consensus, xatu, data]
date: 2026-07-04
---

`beacon_api_eth_v1_proposer_duty` looks block-ish if you only read the name. It has `slot`, `epoch`, `proposer_validator_index`, and a timestamp from the client that fetched it. That is enough rope to build a very wrong proposed-block counter.

The table is not a block feed. From Jun 27 through Jul 3 UTC, it had **1,491,952 raw rows** for **50,400 scheduled slots**, and the duty for the last slot in each epoch first appeared about **6m12s before that slot could produce a block**.

<!-- truncate -->

<img src="/img/proposer-duty-before-blocks.png" alt="Dark line chart showing that Beacon API proposer-duty rows for later slots in an epoch appear up to 6 minutes 12 seconds before slot start, proving the table is an epoch schedule rather than block observations." loading="eager" />

The first pass was deliberately boring. I grouped raw Beacon API proposer-duty rows by slot over seven complete UTC days and compared that to the canonical schedule and the later block-status table. The raw table had a median of **30 rows per slot**, because it is an observation surface: multiple Beacon API observers are asking for proposer duties and writing the returned schedule.

```sql
-- clickhouse-raw
WITH per_slot AS (
  SELECT
    slot,
    count() AS raw_rows,
    uniqExact(meta_client_name) AS emitters,
    uniqExact(meta_consensus_implementation) AS implementations,
    uniqExact(tuple(proposer_validator_index, proposer_pubkey)) AS duty_variants
  FROM default.beacon_api_eth_v1_proposer_duty
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-27 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-04 00:00:00')
  GROUP BY slot
)
SELECT
  sum(raw_rows) AS raw_rows,
  count() AS slots_with_duty_rows,
  quantileExact(0.5)(raw_rows) AS median_rows_per_slot,
  quantileExact(0.95)(raw_rows) AS p95_rows_per_slot,
  quantileExact(0.5)(emitters) AS median_emitters_per_slot,
  max(implementations) AS max_implementations_per_slot,
  countIf(duty_variants != 1) AS slots_with_more_than_one_duty
FROM per_slot;
```

That returned **1,491,952 raw rows**, **50,400 slots**, **30 median rows per slot**, **31 p95 rows per slot**, and **7 observed consensus implementations**. The `slots_with_more_than_one_duty` value was **32**, which I will get to in a minute. The important part is the denominator: the raw row count is about **29.6x** the schedule, not the chain.

The canonical schedule table gives the clean denominator:

```sql
-- clickhouse-raw
SELECT
  count() AS rows,
  uniqExact(slot) AS slots,
  uniqExact(tuple(slot, proposer_validator_index, proposer_pubkey)) AS duty_keys
FROM default.canonical_beacon_proposer_duty
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-27 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-04 00:00:00');
```

That was exactly **50,400 slots** and **50,400 canonical duty keys**, one per slot. The block-status cross-check then split those slots into what actually happened later:

```sql
-- clickhouse-refined
SELECT
  status,
  count() AS slots,
  countIf(block_root IS NOT NULL) AS slots_with_block_root
FROM mainnet.fct_block_proposer FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-27 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-04 00:00:00')
GROUP BY status
ORDER BY status;
```

| status | slots |
| --- | ---: |
| canonical | **50,182** |
| missed | **164** |
| orphaned | **54** |

That is the cleanest way to say it: proposer duties existed for all **50,400** slots, but only **50,182** became canonical blocks. The **164 missed slots** still had duty rows. So did the **54 orphaned slots**. A scheduled proposer is not a proposed block, and an API row for the duty is even further away from being one.

The timing makes the mental model break immediately. The Beacon API proposer-duty endpoint is epoch-shaped. When observers fetch the epoch's duties, the duty for slot 0 is current, slot 1 is about 12 seconds in the future, slot 2 is about 24 seconds in the future, and so on. By slot 31, the same schedule row is visible a little over six minutes before the slot starts.

```sql
-- clickhouse-raw
WITH per_slot AS (
  SELECT
    slot,
    any(slot_start_date_time) AS slot_time,
    min(event_date_time) AS first_event
  FROM default.beacon_api_eth_v1_proposer_duty
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-27 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-04 00:00:00')
  GROUP BY slot
)
SELECT
  slot % 32 AS slot_in_epoch,
  count() AS slots,
  round(
    quantileExact(0.5)(
      greatest(0, dateDiff('millisecond', first_event, slot_time)) / 1000
    ),
    3
  ) AS median_first_row_seconds_before_slot
FROM per_slot
GROUP BY slot_in_epoch
ORDER BY slot_in_epoch;
```

The line in the chart is almost too perfect, which is the point. Slot 0 sat at **0.000s** before slot start. Slot 15 was **179.899s** early. Slot 31 was **371.899s** early. If a table can tell you about a slot six minutes before the slot starts, the row is obviously not evidence that a block was observed.

The one wrinkle was useful too. The raw table had **50,432** distinct `(slot, proposer_validator_index, proposer_pubkey)` duty keys, not **50,400**. That looked scary until I grouped the mismatches: all **32 extra duty keys** came from one observer returning an alternate proposer index for every slot in a single epoch, while the other **30 rows per slot** matched the canonical duty and the block proposer.

```sql
-- clickhouse-raw
WITH multi AS (
  SELECT slot
  FROM default.beacon_api_eth_v1_proposer_duty
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-27 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-04 00:00:00')
  GROUP BY slot
  HAVING uniqExact(tuple(proposer_validator_index, proposer_pubkey)) > 1
)
SELECT
  d.slot,
  any(d.epoch) AS epoch,
  d.proposer_validator_index,
  count() AS raw_rows,
  uniqExact(d.meta_client_name) AS observers
FROM default.beacon_api_eth_v1_proposer_duty d
GLOBAL INNER JOIN multi m ON d.slot = m.slot
WHERE d.meta_network_name = 'mainnet'
  AND d.slot_start_date_time >= toDateTime('2026-06-27 00:00:00')
  AND d.slot_start_date_time <  toDateTime('2026-07-04 00:00:00')
GROUP BY d.slot, d.proposer_validator_index
ORDER BY d.slot, raw_rows DESC;
```

I am not publishing the node label, because that is not the story. The story is that a raw Beacon API duty surface can contain both observer multiplication and a tiny stale-observer tail. If you want the schedule, use `canonical_beacon_proposer_duty` or the refined proposer table. If you want blocks, use block tables. If you want to study what Beacon API observers returned, then this raw table is the right surface, but keep the observer denominator attached to every sentence.
