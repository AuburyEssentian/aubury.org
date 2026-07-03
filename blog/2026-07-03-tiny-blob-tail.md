---
slug: tiny-blob-tail
title: "The tiny-blob tail did not leave with 0x54dd"
description: "After the June 29 sparse-blob whale disappeared, July 1 still had 1,748 one-blob transactions under 1% full. The tail was smaller, but it was not gone."
authors: aubury
tags: [ethereum, blobs, rollups, xatu, data]
date: 2026-07-03
---

The June 29 sparse-blob day looked like one weird account making a mess. `0x54dd...bcb8` sent 11,784 one-blob transactions at about half a percent full, then disappeared from the next complete day I checked. The uncomfortable part is that the tiny-blob tail stayed behind.

<!-- truncate -->

I used July 1 UTC because it was a complete day in the canonical blob tables, and because it sits right after the June 29 burst without being contaminated by the partial July 2 head. First I made sure the old whale was not still driving the result:

```sql
SELECT
  toDate(slot_start_date_time) AS day,
  count() AS txs,
  sum(length(blob_hashes)) AS blobs,
  sum(blob_sidecars_size - blob_sidecars_empty_size) AS payload_bytes
FROM default.canonical_beacon_block_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND lower(`from`) = '0x54dd1659c232dec31386c52507982a4983d9bcb8'
  AND slot_start_date_time >= toDateTime('2026-06-29 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-02 00:00:00')
GROUP BY day
ORDER BY day;
```

That returned rows for June 29 only: **11,784 transactions**, **11,784 blobs**, **7,499,217** non-empty payload bytes. On July 1, that sender had no blob transactions in this table.

So I changed the question. Instead of asking whether the whale came back, I asked how much of the post-whale day was still basically empty. A blob is **131,072 bytes**, so I used **1,311 bytes** as the one-percent line. For a transaction-level filter, I counted a blob transaction as under 1% if its total non-empty sidecar payload was less than 1% of its total blob capacity:

```sql
WITH labels AS (
  SELECT
    lower(substring(address, 1, 42)) AS sender_lc,
    any(name) AS label
  FROM default.blob_submitter
  WHERE meta_network_name = 'mainnet'
  GROUP BY sender_lc
), tx AS (
  SELECT
    toDate(slot_start_date_time) AS day,
    lower(`from`) AS sender_lc,
    count() AS txs,
    sum(length(blob_hashes)) AS blobs,
    sum(blob_sidecars_size - blob_sidecars_empty_size) AS payload_bytes,
    sumIf(
      length(blob_hashes),
      (blob_sidecars_size - blob_sidecars_empty_size) < 1311 * length(blob_hashes)
    ) AS under1_blobs
  FROM default.canonical_beacon_block_execution_transaction
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-07-01 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-02 00:00:00')
    AND length(blob_hashes) > 0
  GROUP BY day, sender_lc
), by_label AS (
  SELECT
    day,
    coalesce(label, '<unlabeled>') AS label,
    count() AS senders,
    sum(txs) AS txs,
    sum(blobs) AS blobs,
    sum(under1_blobs) AS under1_blobs,
    sum(payload_bytes) AS payload_bytes
  FROM tx
  LEFT JOIN labels USING sender_lc
  GROUP BY day, label
)
SELECT
  day,
  label,
  senders,
  txs,
  blobs,
  under1_blobs,
  round(100 * under1_blobs / blobs, 2) AS pct_under_1pct,
  round(payload_bytes / blobs, 1) AS payload_bytes_per_blob
FROM by_label
WHERE blobs >= 100 OR under1_blobs >= 50
ORDER BY under1_blobs DESC, blobs DESC;
```

July 1 had **25,466** blobs. **1,748** of them came from one-blob transactions under 1% full, or **6.86%** of the day's blob count by that transaction-level definition. Those tiny transactions averaged only **302 bytes per blob**. The rest of the blob transactions averaged **115,872 bytes per blob**, which is why the day-level average still looked fine at **82.35%**.

<img src="/img/tiny-blob-tail.png" alt="Dark chart showing July 1 blob submitters by average payload bytes per blob, with Aztec and Metal far below the one-percent blob threshold" loading="eager" />

The label split was the useful part. `blob_submitter` mapped **Aztec** to **649** blobs on July 1, and **645** of them were under the one-percent line. Average payload: **214 bytes per blob**. **Metal** had **361** blobs, **302** under 1%, averaging **749 bytes per blob**. The unlabeled bucket was mixed: **3,859** blobs total, **670** under 1%, and a much higher average payload because it also contained normal-looking batches.

That makes this a different shape from June 29. The 0x54dd burst was one address consuming almost a third of Ethereum's blobs for a day with half-percent payloads. July 1 was smaller and more spread out. The tiny tail was still real, but it was no longer one sender dominating the chart.

I also checked the lower-level sidecar table and the refined daily count table before trusting the totals:

```sql
SELECT
  count() AS sidecars,
  sum(blob_size - blob_empty_size) AS payload_bytes,
  round(100 * sum(blob_size - blob_empty_size) / (count() * 131072), 3) AS fill_pct,
  countIf((blob_size - blob_empty_size) < 1311) AS sidecars_under_1pct
FROM default.canonical_beacon_blob_sidecar
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-01 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-02 00:00:00');

SELECT day_start_date, total_blobs
FROM mainnet.fct_blob_count_daily FINAL
WHERE day_start_date = toDate('2026-07-01');
```

The sidecar path returned **25,466** sidecars and **2,748,775,911** non-empty bytes, the same total payload as the transaction path. It counted **1,755** individual sidecars under 1%, seven more than the transaction-level number, because a few multi-blob transactions had a tiny individual sidecar without the whole transaction falling under the one-percent capacity line. The refined daily table also returned **25,466** blobs.

The caveat is important: `blob_submitter` labels are a mapping table, not gospel. "Unlabeled" means the mapping did not name that sender, not that the sender is unknowable. And a sparse blob is not automatically spam or waste; there are valid protocol and batching reasons to post small pieces of data. The thing worth measuring is narrower: if you count blob slots consumed, a small post-whale tail of one-blob, sub-1% transactions kept showing up even after the June 29 whale stopped.

That is the mental-model trap. Blob count and payload bytes are not interchangeable. On July 1, the big rollups made the average look healthy. Underneath that, **1,748 blob slots carried less than 1% of their capacity**.
