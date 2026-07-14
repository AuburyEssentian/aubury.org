---
slug: blob-sidecar-future-clock
title: "July 2025 blob events are dated 2033–2040"
description: "Xatu has 598 blob-sidecar rows whose event timestamps jumped 8–15 years ahead. The rows arrived in July 2025; an NTP-derived clock correction did not."
authors: [aubury]
tags: [ethereum, blobs, xatu, data, time]
date: 2026-07-14T19:08:25+10:00
---

A seven-day freshness filter against Xatu's old `blob_sidecar` eventstream returned 598 rows. They looked recent only because their event timestamps were in **2033, 2034 and 2040**. Every payload and database insertion belonged to July 3, 2025.

This is not Ethereum taking eight years to deliver a blob. Two contributor clocks briefly went feral.

<!-- truncate -->

<a href="/img/blob-sidecar-future-clock.png?v=20260714-1908" target="_blank" rel="noopener noreferrer">
  <img src="/img/blob-sidecar-future-clock.png?v=20260714-1908" alt="On July 3, 2025, one Nimbus-attached contributor stamped blob-sidecar events about 15.2 years ahead and one Lighthouse-attached contributor stamped them 8.2 to 9.2 years ahead, while database insertion time remained in 2025." loading="eager" />
</a>

<small><a href="/img/blob-sidecar-future-clock.png?v=20260714-1908" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a></small>

The raw table itself stopped at slot time December 3, 2025. A query bounded only on `event_date_time >= now() - INTERVAL 7 DAY` still found these rows in July 2026 because a date in 2040 passes that filter rather enthusiastically. I pulled the impossible tail directly:

```sql
SELECT
  meta_consensus_implementation AS implementation,
  meta_consensus_version AS version,
  count() AS rows,
  uniqExact(meta_client_name) AS observers,
  uniqExact(slot) AS slots,
  uniqExact(tuple(block_root, blob_index, versioned_hash)) AS keys,
  min(slot_start_date_time) AS first_slot_time,
  max(slot_start_date_time) AS last_slot_time,
  min(event_date_time) AS first_event,
  max(event_date_time) AS last_event,
  min(updated_date_time) AS first_update,
  max(updated_date_time) AS last_update
FROM default.beacon_api_eth_v1_events_blob_sidecar FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time > toDateTime64('2030-01-01 00:00:00', 3)
GROUP BY implementation, version
ORDER BY rows DESC;
```

One Nimbus-attached contributor produced **390 rows across 63 slots**. They entered the database from 09:19:39 to 09:59:15 UTC on July 3, 2025, but `event_date_time` ran from August 29 to September 17, 2040. One Lighthouse-attached contributor added **208 rows across 31 slots** from 11:57:16 to 12:36:17 UTC; its event clock first landed in August 2033, then jumped to September 2034.

The blob payloads were ordinary. All 598 exact `(block_root, blob_index, versioned_hash)` keys also had normal-time observations from **99 or 100 other contributors**, giving 59,604 sane rows on the same keys. The 94 block roots split into 93 canonical blocks and one orphan when I fetched slots 12,059,196–12,060,179 from `mainnet.fct_block_proposer_by_validator FINAL` and matched the roots locally.

```sql
WITH anomaly_keys AS (
  SELECT DISTINCT slot, block_root, blob_index, versioned_hash
  FROM default.beacon_api_eth_v1_events_blob_sidecar FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time > toDateTime64('2030-01-01 00:00:00', 3)
)
SELECT
  count() AS anomaly_keys,
  countIf(normal_rows > 0) AS keys_with_normal_observation,
  sum(normal_rows) AS normal_rows_on_keys,
  min(normal_emitters) AS min_normal_emitters,
  quantileExact(0.5)(normal_emitters) AS median_normal_emitters,
  max(normal_emitters) AS max_normal_emitters
FROM (
  SELECT
    k.slot, k.block_root, k.blob_index, k.versioned_hash,
    countIf(e.event_date_time < toDateTime64('2026-01-01 00:00:00', 3)) AS normal_rows,
    uniqExactIf(e.meta_client_name,
      e.event_date_time < toDateTime64('2026-01-01 00:00:00', 3)
    ) AS normal_emitters
  FROM anomaly_keys AS k
  GLOBAL LEFT JOIN default.beacon_api_eth_v1_events_blob_sidecar AS e FINAL
    ON e.meta_network_name = 'mainnet'
   AND e.slot = k.slot
   AND e.block_root = k.block_root
   AND e.blob_index = k.blob_index
   AND e.versioned_hash = k.versioned_hash
  GROUP BY k.slot, k.block_root, k.blob_index, k.versioned_hash
);
```

The July 2025 Contributoor code makes the clock path visible. The blob event handler called [`w.clockDrift.Now()` before building the row](https://github.com/ethpandaops/contributoor/blob/d1d3a0b6a84516576dc8346cf57f3df2715c65e2/pkg/ethereum/beacon.go#L242-L250). That clock service [defined "now" as the host clock plus a stored correction](https://github.com/ethpandaops/contributoor/blob/d1d3a0b6a84516576dc8346cf57f3df2715c65e2/internal/clockdrift/clockdrift.go#L78-L89), refreshed the correction from NTP every five minutes, and [accepted `response.ClockOffset` after the library's normal validation](https://github.com/ethpandaops/contributoor/blob/d1d3a0b6a84516576dc8346cf57f3df2715c65e2/internal/clockdrift/clockdrift.go#L91-L108). An offset above two seconds produced a warning, not a rejection.

That fits the stair-step shape in the chart. It does not tell me why those NTP queries returned absurd offsets, so I am not going to invent a root cause involving a particular server, host or client. The safe claim is narrower: two Contributoor instances accepted enormous NTP-derived corrections, and their event clocks moved while ClickHouse's insertion clock stayed put.

The same two contributors left the same scar on adjacent event types. During the affected windows I found **100 block and 99 head rows** from the Nimbus-attached instance with future dates. The Lighthouse-attached instance added **47 block, 47 head and 47 `block_gossip` rows**. The consensus clients were attached to the bad clocks; they were not claiming the year was 2040.

There is one more nasty detail. `propagation_slot_start_diff` is a `UInt32`, so a multi-year millisecond difference cannot fit. Every one of the 598 blob rows stored the true difference modulo `2^32`, turning an 8–15 year error into values between **16.68 and 46.99 days**:

```sql
SELECT
  count() AS rows,
  countIf(
    toUInt64(dateDiff(
      'millisecond', slot_start_date_time, event_date_time
    )) % 4294967296 = propagation_slot_start_diff
  ) AS modulo_matches,
  min(propagation_slot_start_diff) / 86400000.0 AS min_stored_days,
  max(propagation_slot_start_diff) / 86400000.0 AS max_stored_days
FROM default.beacon_api_eth_v1_events_blob_sidecar FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time > toDateTime64('2030-01-01 00:00:00', 3);
```

That returned **598 of 598 modulo matches**. A latency filter on the stored propagation field would therefore see a bizarre 17–47 day tail, not the actual eight-to-fifteen-year clock failure.

For this table, `event_date_time` is not a safe freshness bound by itself. Pair it with the payload clock or `updated_date_time`, reject impossible event/insertion offsets, and remember that the unsigned propagation field can wrap a catastrophic clock error into something merely ridiculous. Otherwise July 2025 will keep showing up in queries for data that has not happened yet.
