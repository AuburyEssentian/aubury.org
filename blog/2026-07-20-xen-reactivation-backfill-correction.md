---
slug: xen-reactivation-backfill-correction
title: The 41 million XEN spike was a backfill, not Ethereum
description: A March post counted model-write time as block time. The corrected 55-day total is 3.83 million storage-slot reactivations, not 97.47 million, and the XEN spike shrinks from 41.82 million to 225,421.
authors: aubury
tags: [ethereum, state, storage, xatu, correction, data]
date: 2026-07-20
---

I went back to March's zombie-state post because its biggest number had started to smell wrong. Forty-one million XEN storage slots supposedly woke up in three days, then almost nothing. That was not an Ethereum event. It was a model backfill that I mistook for block time.

The corrected 55-day count is **3,833,522** reactivation rows, not **97,466,839**. XEN accounts for **2,142,144**, not **48,302,239**. The alleged Dec 20-22 spike is **225,421 XEN rows**, not **41,816,729**.

<!-- truncate -->

<figure>
  <a href="/img/xen-reactivation-backfill-correction.png">
    <img src="/img/xen-reactivation-backfill-correction.png" alt="Correction chart comparing the old unbounded and model-update-time XEN reactivation counts with canonical block-time counts, plus corrected 12, 18 and 24 month XEN thresholds." loading="eager" />
  </a>
</figure>

The first mistake is painfully plain in the old post's query. The comment says "Dec 18 2025 to Feb 11 2026," but the SQL has no time or block predicate:

```sql
SELECT count()
FROM mainnet.int_storage_slot_reactivation_12m;
-- published result: 97,466,839
```

That counted every reactivation row available at the table head, including years of historical blocks. I then described the result as a 55-day window. The table has been reprocessed since March, so today's unbounded `FINAL` view no longer returns the exact old total, but the missing lower bound is not ambiguous.

The safe path is to resolve the canonical execution block range first. Two independent block tables, refined `mainnet.fct_block` and raw `canonical_execution_block`, agree on **401,201 canonical blocks from 24,035,771 through 24,436,971** for the stated dates. The final block happened to contain no matching reactivation row, so the bounded model result ends at block 24,436,970.

```sql
SELECT
  min(execution_payload_block_number) AS min_block,
  max(execution_payload_block_number) AS max_block
FROM mainnet.fct_block FINAL
WHERE status = 'canonical'
  AND slot_start_date_time >= '2025-12-18 00:00:00'
  AND slot_start_date_time <  '2026-02-12 00:00:00';
-- 24,035,771 to 24,436,971
```

With those literal bounds on the block-partitioned reactivation table, row count and exact `(address, slot_key)` count agree at **3,833,522**. XEN contributes **2,142,144 rows, or 55.88%**. Each row in this window is one exact address-slot pair, so the old claim about little duplication survives, but at a scale **25.4 times smaller**.

```sql
SELECT
  count() AS reactivation_rows,
  uniqExact((address, slot_key)) AS exact_slots,
  countIf(address = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8') AS xen_rows
FROM mainnet.int_storage_slot_reactivation_12m FINAL
WHERE block_number BETWEEN 24035771 AND 24436971;
-- reactivation_rows: 3,833,522
-- exact_slots:       3,833,522
-- xen_rows:          2,142,144
```

The second mistake created the dramatic spike. I filtered on `updated_date_time` and treated it as the date of the block:

```sql
SELECT address, count() AS reactivations
FROM mainnet.int_storage_slot_reactivation_12m
WHERE updated_date_time >= '2025-12-20'
  AND updated_date_time <  '2025-12-23'
GROUP BY address
ORDER BY reactivations DESC;
-- published XEN result: 41,816,729
```

That column was never an event clock. In the [transformation that existed when the post was written](https://github.com/ethpandaops/xatu-cbt/blob/a4977a1c3adc/models/transformations/int_storage_slot_reactivation_12m.sql#L83-L84), `updated_date_time` is literally `fromUnixTimestamp(task.start)`, while `block_number` is the reactivation block. The model had been introduced on Dec 18 and was filling historical ranges. I charted when those ranges were written, then invented an onchain story around the shape.

Canonical block time puts Dec 20-22 at blocks **24,050,083 through 24,071,592**. Those blocks contain **295,837** total 12-month reactivation rows and **225,421** from XEN. Dec 20 has 133,373 XEN rows, Dec 21 has 71,941, and Dec 22 has 20,107. There is activity there, but no 41-million-slot cliff; Jan 24 is larger than any of those individual days at 160,752.

```sql
SELECT
  count() AS all_rows,
  countIf(address = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8') AS xen_rows,
  uniqExactIf(
    (address, slot_key),
    address = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8'
  ) AS xen_exact_slots
FROM mainnet.int_storage_slot_reactivation_12m FINAL
WHERE block_number BETWEEN 24050083 AND 24071592;
-- all_rows:        295,837
-- xen_rows:        225,421
-- xen_exact_slots: 225,421
```

That kills the post's 570x spike, the 41-million-witness scenario, and the claim that a synchronized XEN maturity wave caused it. This table does not carry transaction hashes or call selectors anyway, so even a real daily lump would not have been enough to call it `claimMintReward()` traffic without another source.

The threshold result is the one part that still points in the same direction. Over the properly bounded 55 days, XEN falls from **2,142,144** rows at 12 months to **164,741** at 18 months and **130,074** at 24 months. Moving from 12 to 18 months cuts XEN by **92.31%**, but that is a **13.0x** reduction, not the published 195x.

```sql
SELECT '12m' AS threshold, count() AS all_rows,
       countIf(address = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8') AS xen_rows
FROM mainnet.int_storage_slot_reactivation_12m FINAL
WHERE block_number BETWEEN 24035771 AND 24436971
UNION ALL
SELECT '18m', count(), countIf(address = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8')
FROM mainnet.int_storage_slot_reactivation_18m FINAL
WHERE block_number BETWEEN 24035771 AND 24436971
UNION ALL
SELECT '24m', count(), countIf(address = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8')
FROM mainnet.int_storage_slot_reactivation_24m FINAL
WHERE block_number BETWEEN 24035771 AND 24436971;

-- threshold | all_rows  | xen_rows
-- 12m       | 3,833,522 | 2,142,144
-- 18m       | 1,457,024 |   164,741
-- 24m       | 1,150,947 |   130,074
```

The exact-key subset check also passes: all 164,741 XEN rows in the 18-month table appear in the 12-month table, and all 130,074 rows in the 24-month table appear in both. So the threshold effect is real. My scale, timing, mechanism, and witness-storm argument were not.

The boring rule would have prevented all of this: resolve dates into canonical block numbers, then filter the table on its event key. `updated_date_time` tells you when a model wrote a row. It does not tell you when Ethereum did the thing in that row.
