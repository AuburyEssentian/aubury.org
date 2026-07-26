---
slug: peerdas-parity-compression-cliff
title: Sparse blobs stop looking sparse at PeerDAS column 64
description: "Raw Gossipsub payload bytes show a 4.42x compression cliff between PeerDAS's original and recovery columns when blob data is sparse."
authors: aubury
tags: [ethereum, peerdas, blobs, xatu, data]
date: 2026-07-17T21:09:22+10:00
---

Mostly empty blobs compress beautifully. PeerDAS's recovery half does not.

Xatu started preserving raw Gossipsub message payloads this morning. In the first two complete hours, I found 448 canonical blob blocks with all 128 column sidecars captured. For the 97 blocks below 25% blob fill, columns 64–127 used **4.42 times as many compressed payload bytes** as columns 0–63. The same ratio was only 1.02x for blocks above 75% fill.

<!-- truncate -->

<a href="/img/peerdas-parity-compression-cliff.png">
  <img src="/img/peerdas-parity-compression-cliff.png" alt="Median compressed PeerDAS column payload size, showing a sharp jump at column 64 for sparse blobs" loading="eager" />
</a>

The new table is unusually useful because it keeps the exact Snappy-compressed SSZ payload, not another count derived from a decoded object. I used the complete 08:00–10:00 UTC window after the capture came online, reduced it to one row per `(topic, message_id)`, then matched those IDs to the parsed data-column table.

```sql
SELECT
  topic_name,
  message_id,
  argMax(message_size, tuple(event_date_time, updated_date_time)) AS payload_bytes,
  length(argMax(message_data, tuple(event_date_time, updated_date_time))) AS stored_bytes
FROM default.libp2p_gossipsub_message_payload FINAL
WHERE meta_network_name = 'mainnet'
  AND wallclock_slot_start_date_time >= toDateTime('2026-07-17 08:00:00')
  AND wallclock_slot_start_date_time <  toDateTime('2026-07-17 10:00:00')
  AND startsWith(topic_name, 'data_column_sidecar_')
GROUP BY topic_name, message_id
```

That produced 57,344 payloads for the 448 complete blocks, exactly 128 per block. Two more canonical blob blocks had only 127 captured columns and were excluded. The complete cohort carried 2,467 blobs.

I calculated fill from the transaction rows, not from the new payload table. `blob_sidecars_size` equalled `length(blob_hashes) * 131072` for every blob block in the window, so subtracting the explicit empty-byte count gives the non-zero blob bytes.

```sql
SELECT
  slot,
  block_root,
  sum(length(blob_hashes)) AS blob_count,
  sum(toUInt64(ifNull(blob_sidecars_size, 0))) AS capacity_bytes,
  sum(toUInt64(ifNull(blob_sidecars_empty_size, 0))) AS empty_bytes,
  capacity_bytes - empty_bytes AS nonzero_bytes
FROM default.canonical_beacon_block_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-17 08:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-17 10:00:00')
GROUP BY slot, block_root
```

The blob denominator survived three checks. `execution_payload_blob_gas_used / 131072` from the canonical block header, the explicit transaction `blob_hashes` count, and `mainnet.fct_block_blob_count FINAL` agreed for every block. This matters here because a wrong blob count would change both the fill bucket and the expected sidecar length.

The sparse cohort was genuinely sparse. Its median fill was **0.677%**, with a median **1,423 non-zero bytes** per block. Yet one complete set of its 64 original-column payloads took a median 37,472 compressed bytes, while the 64 recovery-column payloads took 159,872 bytes.

The cleanest subset was 46 one-blob blocks at or below 1% fill. Their median blob held **198 non-zero bytes**. The original half compressed to 35,984 bytes across its 64 messages; the recovery half stayed at 159,872 bytes. That is a **4.44x** split inside blocks with the same blob count, header and sidecar structure.

## The block that made it obvious

[Slot 14,787,625](https://beaconcha.in/slot/14787625) carried one blob with 112 non-zero bytes, or 0.0854% fill. I pulled columns 0, 63, 64 and 127 by their exact message IDs and decompressed the stored payloads. Every SSZ object was 2,500 bytes before Snappy, so the difference was compression, not a different container shape.

- **Column 0:** 664 B compressed; 94.87% of the 2,048-byte cell was zero.
- **Column 63:** 559 B compressed; the cell was 100.00% zero.
- **Column 64:** 2,498 B compressed; only 0.39% of the cell was zero.
- **Column 127:** 2,498 B compressed; only 0.24% of the cell was zero.

PeerDAS starts with a 4,096-field-element blob, 64 cells of 64 field elements each. Fulu extends that polynomial to 8,192 field elements, or 128 cells. The first 64 cells hold the original evaluation set; the next 64 are the erasure-coded recovery set. The [DAS core spec](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/fulu/das-core.md) then puts one cell from each blob into each `DataColumnSidecar`.

Zeros in the original cells are easy for Snappy. The recovery cells are polynomial evaluations at additional points, so a blob with a small non-zero patch can produce dense-looking field elements across the second half. That is the cliff in the chart. Dense blobs do not show much of one because both halves already resist compression: the 302 blocks above 75% fill had a median recovery/original ratio of **1.0226x**.

This is useful redundancy, not mysterious bloat. Any 64 of the 128 cells can reconstruct the blob. The raw bytes make the cost of that property visible in a way that a simple "non-zero blob bytes" metric cannot.

## A couple of sharp edges

The raw-payload table started at 07:44 UTC and had three Tysm observers, so this is a two-hour codec and container study, not a traffic trend or a network census. The totals are one deduplicated payload for each column. They exclude libp2p transport and control framing, and they do not say how many copies crossed the network or how many columns a particular node downloaded.

The broader parsed sidecar table also gave me a useful awkward check. It matched 57,598 raw payload IDs, but 284 IDs had two observed `message_size` values and 59 of the selected raw/parsed sizes differed. The exact cause of those alternate sizes is not exposed. It does not drive the result: all 128 per-column medians were identical on both paths, and the low-fill ratio was 4.4193x from stored raw bytes versus 4.4189x from the parsed sidecar sizes.

An all-zero blob would extend to all zeros, so this is not a claim that every sparse input must produce dense recovery cells. That is what happened for the real low-fill blobs in this window. The compressed recovery half was larger in all 448 complete blocks.

A sparse blob is sparse in the first half of PeerDAS. The recovery half is doing its job, and Snappy can see it.
