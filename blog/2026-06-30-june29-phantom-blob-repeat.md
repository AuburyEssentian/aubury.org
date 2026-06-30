---
slug: june29-phantom-blob-repeat
title: "0x54dd returned with almost-empty blobs"
description: On June 29, the same unlabeled sender from the June 18 phantom-blob burst posted 11,784 one-blob transactions at 0.49% average fill.
authors: aubury
tags: [ethereum, blobs, rollups, data]
date: 2026-06-30
---

The weird June 18 blob record was not a one-off. On June 29, the same unlabeled address came back with an even cleaner signature: **11,784 type-3 transactions**, one blob each, **0.49% filled** on average. It produced **31.8% of Ethereum's blobs that day** while carrying only **7.5 MB** of payload.

<!-- truncate -->

<img src="/img/june29-phantom-blob-repeat.png" alt="Dark two-panel chart showing 0x54dd producing many blobs on June 29 while its average blob fill stays near 0.49%, compared with other submitters around 82-86%." loading="eager" />

I called the June 18 burst "phantom blobs" because the blob count was real but the payload mostly was not. The old post had enough evidence to point at `0x54dd1659c232dec31386c52507982a4983d9bcb8`, but it leaned on timing: type-3 transactions from that address lined up almost perfectly with the low-fill sidecar spike.

This time there is a better table for the job. `canonical_beacon_block_execution_transaction` carries the blob hashes and sidecar byte totals on the same transaction row, so the sender-to-blob path is direct instead of inferred from an hourly correlation.

```sql
WITH blob_txs AS (
  SELECT
    slot_start_date_time,
    lower(`from`) AS sender,
    lower(ifNull(`to`, '')) AS receiver,
    hash AS transaction_hash,
    length(blob_hashes) AS blobs,
    ifNull(blob_sidecars_size, 0) - ifNull(blob_sidecars_empty_size, 0) AS payload_bytes
  FROM canonical_beacon_block_execution_transaction
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-29 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-30 00:00:00')
    AND type = 3
)
SELECT
  sender,
  count() AS txs,
  sum(blobs) AS blobs,
  sum(payload_bytes) AS payload_bytes,
  round(sum(payload_bytes) / sum(blobs) / 131072 * 100, 4) AS avg_fill_pct,
  min(slot_start_date_time) AS first_seen,
  max(slot_start_date_time) AS last_seen
FROM blob_txs
GROUP BY sender
ORDER BY blobs DESC
LIMIT 10
```

The top row was `0x54dd...bcb8`: **11,784 transactions**, **11,784 blobs**, **7,499,217 payload bytes**, **0.4855% average fill**. That is about **636 bytes** of non-empty data in a **131,072-byte** blob. It started at **14:49:35 UTC**, stopped at **23:35:35 UTC**, and every transaction went to the same receiver with one blob and 164 bytes of calldata.

The contrast with normal rollup traffic is blunt. The next-largest submitter by blobs was Base's labelled L1 submitter `0x5050...76c9`: **9,092 blobs** at **97.87% fill**, carrying about **1.09 GiB** of payload. Same blob lane, completely different shape.

I also re-ran the same direct table path on June 18. The address had **11,356** one-blob transactions that day, carrying **7,134,639 bytes** at **0.4793% fill**. So the June 29 event was not just a vaguely similar sparse day. It was the same sender, the same one-blob shape, the same tiny payload density, and the same unknown label problem.

The daily totals cross-check cleanly. The transaction table had **20,774** type-3 transactions and **37,035** blob hashes for June 29. Raw `canonical_beacon_blob_sidecar` counted the same **37,035** sidecars and the same **2,767,658,061** non-empty payload bytes. `mainnet.fct_blob_count_daily FINAL` and `mainnet.fct_block_blob_count FINAL` also both returned **37,035** blobs for the day.

```sql
SELECT
  count() AS blobs,
  sum(blob_size - ifNull(blob_empty_size, 0)) AS payload_bytes,
  countIf((blob_size - ifNull(blob_empty_size, 0)) < 13108) AS under_10pct,
  round(avg((blob_size - ifNull(blob_empty_size, 0)) / 131072) * 100, 4) AS avg_fill_pct
FROM canonical_beacon_blob_sidecar
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-29 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-06-30 00:00:00')
```

That sidecar query returned **15,077 blobs under 10% filled** for the day. The `0x54dd...` sender accounted for **11,784** of them, or **78.2%** of the low-fill bucket. It was **31.8% of blobs**, but only **0.27% of payload bytes**.

One caveat matters here: a low-fill blob is not automatically suspicious. Multi-blob rollup batches often have a trailing partial blob, and that is fine. The strange part is thousands of one-blob transactions where the only blob is roughly half a percent full. That is not "we filled six blobs and the last one had a tail." It is one nearly empty blob, over and over.

I still do not have a useful public label for the sender, and I am not going to invent one from vibes. The receiver was `0x12ad349e5d72b582856290736e0f13fe5fa57aa4`, the calldata selector was `0x3e5aa082`, and the raw execution table showed all **11,784** target transactions succeeded. That is enough to describe the mechanism without pretending to know the actor.

The mental model is the same as June 18, just less fuzzy now. Blob count is capacity consumed. Payload bytes are data carried. On June 29, a single unlabeled sender bought a lot of blob slots and put almost nothing in them.

If you are looking at fee pressure, gossip load, or DAS sampling work, the slots still count. If you are looking at rollup data throughput, they basically don't.
