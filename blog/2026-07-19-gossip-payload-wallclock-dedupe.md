---
slug: gossip-payload-wallclock-dedupe
title: "The content-deduped gossip archive keeps one row per slot"
description: "In a two-hour mainnet window, 18.1% of aggregate-and-proof message IDs survived twice because Xatu's raw payload archive includes the receiving wallclock slot in its dedupe key."
authors: aubury
tags: [ethereum, libp2p, xatu, data-quality]
date: 2026-07-19
---

Xatu v1.22 added an archive for raw Gossipsub wire bytes. The table uses content-derived message IDs and a replacing merge tree, so it sounds safe to treat `count()` as a unique-message count.

It is not. In a two-hour mainnet window, **35,806 of 197,889 aggregate-and-proof message IDs survived twice**. The second row appeared when the same content ID crossed a 12-second wallclock-slot boundary.

<!-- truncate -->

<a href="/img/gossip-payload-wallclock-dedupe.png">
  <img src="/img/gossip-payload-wallclock-dedupe.png" alt="Dark chart showing that 18.09% of aggregate-and-proof message IDs and 17.56% of sync-contribution IDs had two retained raw-payload rows because every repeated ID crossed a wallclock-slot boundary" loading="eager" />
</a>

## The key is the receiving slot

I used July 18 from 12:00 to 14:00 UTC, well after the new capture had started and well before the table's current head. I grouped by content ID first, then checked how many wallclock slots each ID occupied. That distinction is the whole post.

```sql
SELECT
  family,
  count() AS message_id_count,
  sum(id_rows) AS total_stored_rows,
  sum(id_rows - 1) AS extra_row_count,
  countIf(id_rows > 1) AS repeated_id_count,
  round(100 * countIf(id_rows > 1) / count(), 4) AS repeated_id_pct,
  countIf(wallclock_slot_count > 1) AS cross_slot_id_count,
  max(wallclock_slot_count) AS max_wallclock_slots,
  quantileExactIf(0.50)(span_ms, id_rows > 1) AS repeated_span_p50_ms,
  quantileExactIf(0.95)(span_ms, id_rows > 1) AS repeated_span_p95_ms
FROM (
  SELECT
    multiIf(
      startsWith(topic_name, 'beacon_attestation_'), 'attestation',
      topic_name = 'beacon_aggregate_and_proof', 'aggregate_and_proof',
      topic_name = 'sync_committee_contribution_and_proof', 'sync_contribution_and_proof',
      startsWith(topic_name, 'data_column_sidecar_'), 'data_column_sidecar',
      topic_name
    ) AS family,
    message_id,
    count() AS id_rows,
    uniqExact(wallclock_slot) AS wallclock_slot_count,
    dateDiff('millisecond', min(event_date_time), max(event_date_time)) AS span_ms
  FROM default.libp2p_gossipsub_message_payload FINAL
  WHERE meta_network_name = 'mainnet'
    AND wallclock_slot_start_date_time >= toDateTime('2026-07-18 12:00:00')
    AND wallclock_slot_start_date_time <  toDateTime('2026-07-18 14:00:00')
    AND (
      startsWith(topic_name, 'beacon_attestation_')
      OR topic_name IN (
        'beacon_aggregate_and_proof',
        'sync_committee_contribution_and_proof'
      )
      OR startsWith(topic_name, 'data_column_sidecar_')
    )
  GROUP BY family, message_id
)
GROUP BY family
ORDER BY total_stored_rows DESC;
```

The retained-row shape was not remotely uniform:

- Aggregate and proof: **233,695 rows for 197,889 IDs**. Exactly 35,806 IDs, or **18.0940%**, appeared twice.
- Sync contribution and proof: **16,405 rows for 13,954 IDs**. Exactly 2,451 IDs, or **17.5649%**, appeared twice.
- Attestation: **3,791,426 rows for 3,716,225 IDs**. The repeated share was **2.0236%**.
- Data-column sidecar: **69,931 rows for 69,888 IDs**. Only 43 IDs repeated, or **0.0615%**.

Every repeated ID in those four families occupied two wallclock slots. None survived three times. For aggregate-and-proof, the repeated pair was separated by 5.555 seconds at p50 and 11.969 seconds at p95. The attestation tail was longer: 10.685 seconds at p50 and 92.420 seconds at p95.

That timing is the clue. The rows are not multiplying randomly inside one receiving slot. They are walking over the slot boundary.

## Why `FINAL` does not remove the second row

The [Xatu migration](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/deploy/migrations/clickhouse/xatu/006_libp2p_gossipsub_message_payload.up.sql) uses `ReplicatedReplacingMergeTree`, but the full sort key is:

```sql
ORDER BY (
  meta_network_name,
  wallclock_slot_start_date_time,
  topic_fork_digest_value,
  topic_name,
  message_id
)
```

ReplacingMergeTree only merges rows whose sort keys match. Receive the same content ID before and after the next slot starts, and `wallclock_slot_start_date_time` changes. Those are now two keys, so both rows survive `FINAL`.

The migration comment says this directly: deduplication is best effort, and clients that receive the same message on opposite sides of a wallclock-slot or partition boundary keep one row per side. The surprising part is the scale. In six complete two-hour checks after capture stabilised, the repeated aggregate-ID share ranged from **16.21% to 29.32%**. This is ordinary archive behaviour, not one bad minute.

I also checked the five longest aggregate examples against `default.libp2p_gossipsub_aggregate_and_proof`. Each ID had one attestation slot and one `(slot, committee, aggregator, voted root, source, target)` tuple. The parsed surface carried 39 to 43 observation rows per ID over 392.7 to 409.3 seconds; the payload archive kept two rows because the captures landed in different receiving slots.

## Same ID, occasionally different compressed bytes

Most repeated aggregate IDs also retained the same raw payload bytes on both sides. A small tail did not: **271 of the 35,806 repeated IDs** had two `message_data` values, and 266 had two compressed sizes.

```sql
SELECT
  count() AS message_id_count,
  countIf(id_rows > 1) AS repeated_id_count,
  countIf(data_variants > 1) AS data_variant_ids,
  countIf(size_variants > 1) AS size_variant_ids,
  countIf(topic_variants > 1) AS topic_variant_ids
FROM (
  SELECT
    message_id,
    count() AS id_rows,
    uniqExact(message_data) AS data_variants,
    uniqExact(message_size) AS size_variants,
    uniqExact(tuple(
      topic_fork_digest_value, topic_name, topic_encoding
    )) AS topic_variants
  FROM default.libp2p_gossipsub_message_payload FINAL
  WHERE meta_network_name = 'mainnet'
    AND wallclock_slot_start_date_time >= toDateTime('2026-07-18 12:00:00')
    AND wallclock_slot_start_date_time <  toDateTime('2026-07-18 14:00:00')
    AND topic_name = 'beacon_aggregate_and_proof'
  GROUP BY message_id
);
```

That returned 197,889 IDs, 35,806 repeated IDs, 271 byte-variant IDs, 266 size-variant IDs and zero topic variants. The Ethereum [Gossipsub message-ID rule](https://github.com/ethereum/consensus-specs/blob/8c12caee279d77b322446d33440b37479117dcde/specs/phase0/p2p-interface.md) explains why this is possible: for valid Snappy payloads, the ID hashes the decompressed message data. The spec explicitly allows several Snappy byte strings to decompress to the same value.

So `message_id` is the honest content denominator here. `count()` measures retained archive rows, while `sum(message_size)` measures retained compressed copies. Neither is a unique-message metric unless the query collapses the receiving-slot dimension first.

The table is doing what its migration says. The shorthand was the trap: content-deduped does not mean one row per content ID. Here it means one row per content ID, topic and receiving wallclock slot.
