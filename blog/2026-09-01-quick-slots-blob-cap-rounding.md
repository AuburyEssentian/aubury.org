---
slug: quick-slots-blob-cap-rounding
title: "Quick Slots rounds the blob target up and the cap down"
description: "An open 10-second EIP-8198 branch moves Ethereum from 21/14 blobs per slot to 17/12. The per-minute maximum falls while the target rises, and 2,511 recent Mainnet blocks exceed the proposed cap."
authors: aubury
tags: [ethereum, blobs, eip-8198, quick-slots, data]
date: 2026-09-01
---

The open 10-second branch of EIP-8198 says blob throughput stays unchanged per unit of wall-clock time. That is the intention. The integers refuse: the hard maximum falls from 105 to 102 blobs per minute, while the target rises from 70 to 72.

The arithmetic is small, but it changes real block packing. In the last 14 complete UTC days, **2,511 canonical Mainnet blocks carried more than the branch's proposed 17-blob cap**. A shorter-slot chain gets more blocks in the same minute, so those blobs are not lost. The old block packing still has to change.

<!-- truncate -->

EIP-8198 is still Draft. The [current EIP text](https://eips.ethereum.org/EIPS/eip-8198) targets eight-second slots and scales the 21-blob maximum down to 14. [PR #12217](https://github.com/ethereum/EIPs/pull/12217) is an open, unmerged alternative that targets ten seconds; I froze its head at [`f76735f`](https://github.com/ethereum/EIPs/blob/f76735fcc51fc76eca60cb7e4156c1916388dd64/EIPS/eip-8198.md). Nothing here is scheduled for Mainnet.

## The integers do not stay flat

The ten-second branch explicitly changes the blob schedule from a maximum/target of `21 / 14` to `17 / 12`. Converting both schedules to one minute makes the rounding visible:

- Current 12-second slots: `21 × 5 = 105` maximum, `14 × 5 = 70` target.
- Open 10-second PR: `17 × 6 = 102` maximum, `12 × 6 = 72` target.

So the maximum rate is **2.86% lower**, while the target rate is **2.86% higher**. The branch rescales the fee update fraction separately, but it cannot make both integer blob limits exactly flat. The current eight-second text has a different rounding shape: `floor(21 × 8 / 12) = 14`, which keeps the 105-per-minute maximum exact.

I checked how often recent Mainnet blocks use the part of the current range that each branch removes. This is the executed aggregate behind the chart:

```sql
SELECT
    toDate(slot_start_date_time) AS day,
    count() AS blob_blocks,
    sum(blob_count) AS total_blobs,
    countIf(blob_count > 14) AS over_14_blocks,
    sumIf(blob_count - 14, blob_count > 14) AS excess_over_14,
    countIf(blob_count > 17) AS over_17_blocks,
    sumIf(blob_count - 17, blob_count > 17) AS excess_over_17,
    max(blob_count) AS max_blobs
FROM mainnet.fct_block_blob_count FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-18 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-09-01 00:00:00')
  AND status = 'canonical'
GROUP BY day
ORDER BY day;
```

<img
  src="/img/quick-slots-blob-cap-rounding.png"
  alt="Daily share of canonical Mainnet blocks above the 17-blob cap in the open ten-second Quick Slots PR and above the 14-blob cap in the current eight-second EIP text"
  loading="eager"
/>

The window contained **100,454 canonical blocks**, of which 81,046 carried at least one blob. The 10-second branch would require different packing for **2,511 blocks**, or 2.50% of all canonical blocks. Those blocks held 6,456 blobs above position 17, equal to 1.22% of all 529,346 blobs in the window.

The current eight-second text moves the line further down. **5,175 blocks** carried more than 14 blobs, or 5.15% of all canonical blocks. Their positions above 14 contained 18,740 blobs, 3.54% of the period's blob total. Every day in the window had blocks above both proposed caps; this was not one odd burst.

## This is repacking, not rejection

The block result sounds harsher than the transaction result. I grouped the raw canonical transaction path by the number of versioned hashes on each blob transaction:

```sql
SELECT
    transaction_blob_count,
    count() AS canonical_transactions,
    sum(transaction_blob_count) AS total_blobs
FROM
(
    SELECT
        hash,
        length(blob_hashes) AS transaction_blob_count
    FROM default.canonical_beacon_block_execution_transaction FINAL
    WHERE meta_network_name = 'mainnet'
      AND slot_start_date_time >= toDateTime('2026-08-18 00:00:00')
      AND slot_start_date_time <  toDateTime('2026-09-01 00:00:00')
      AND length(blob_hashes) > 0
)
GROUP BY transaction_blob_count
ORDER BY transaction_blob_count;
```

All **176,693 blob transactions** carried between one and six blobs. None individually exceeded either proposed per-block cap. Builders could spread the same transactions across the extra shorter slots, subject to fees, arrival time, gas, and whatever demand does after a fork. This fixed-history backcast cannot simulate that new packing game.

The checks were pleasantly boring. `mainnet.fct_block_blob_count FINAL` and raw `canonical_beacon_blob_sidecar FINAL` produced the same count at every block blob-count value from one through 21. Both paths summed to 529,346 blobs. Raw and refined canonical block tables also matched on all 100,454 exact `(slot, block_root)` pairs.

Quick Slots can keep blob capacity roughly level per second. It cannot preserve today's per-block blob packing, and the ten-second rounding does not keep both the target and maximum rates flat at once. Those are different promises.
