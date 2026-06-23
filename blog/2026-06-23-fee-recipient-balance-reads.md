---
slug: fee-recipient-balance-reads
title: Every transaction reads the fee recipient
description: On June 21, every canonical Ethereum transaction in Xatu had exactly one balance read against the block author address, making Titan's fee recipient a hotter balance-read target than USDT.
authors: aubury
tags: [ethereum, execution, xatu, panda, data]
date: 2026-06-23
---

USDT was not the hottest address in the balance-read table.

I expected the usual suspects: USDT, USDC, WETH, routers, precompiles, some unlabeled contract that every block touches. They are all there. But the biggest line in the one-day sample was a builder fee recipient, because the execution path records a balance read against the block author once per transaction.

That sounds obvious after you see it. It was not obvious from the table name.

<!-- truncate -->

<a href="/img/fee-recipient-balance-reads.png"><img src="/img/fee-recipient-balance-reads.png" alt="Top Ethereum execution balance-read addresses on June 21 2026, led by Titan, Quasar, and Eureka fee-recipient addresses ahead of USDT." loading="eager" /></a>

The table here is `canonical_execution_balance_reads`. It is not ERC-20 storage. It is not a disk I/O counter. It is Xatu's logical execution instrumentation for ETH balance reads.

On June 21 UTC, canonical Ethereum blocks in the sample had **2,924,395** transactions. The same blocks had **2,924,395** balance reads where the read address was the block `author`, also known as the fee recipient / coinbase address.

At transaction granularity, it was exact:

- **2,924,395** transactions
- **2,924,395** transactions with exactly one fee-recipient balance read
- **0** with none
- **0** with more than one

The per-block shape held across the six complete UTC days I checked, from June 16 through June 21. Every tx-bearing block had `author_balance_reads == transaction_count`.

```sql
WITH
  blocks AS (
    SELECT block_number, lower(author) AS author
    FROM default.canonical_execution_block
    WHERE meta_network_name = 'mainnet'
      AND block_date_time >= toDateTime('2026-06-21 00:00:00')
      AND block_date_time <  toDateTime('2026-06-22 00:00:00')
      AND author IS NOT NULL
  ),
  tx AS (
    SELECT block_number, transaction_hash
    FROM default.canonical_execution_transaction
    WHERE meta_network_name = 'mainnet'
      AND block_number BETWEEN 25362243 AND 25369413
  ),
  ar AS (
    SELECT
      r.block_number,
      r.transaction_hash,
      count() AS author_reads
    FROM default.canonical_execution_balance_reads r
    GLOBAL INNER JOIN blocks b ON r.block_number = b.block_number
    WHERE r.meta_network_name = 'mainnet'
      AND r.block_number BETWEEN 25362243 AND 25369413
      AND lower(r.address) = b.author
    GROUP BY r.block_number, r.transaction_hash
  )
SELECT
  count() AS txs,
  countIf(coalesce(ar.author_reads, 0) = 1) AS one_author_read_txs,
  countIf(coalesce(ar.author_reads, 0) = 0) AS zero_author_read_txs,
  countIf(coalesce(ar.author_reads, 0) > 1) AS multi_author_read_txs,
  sum(coalesce(ar.author_reads, 0)) AS author_reads
FROM tx
LEFT JOIN ar
  ON tx.block_number = ar.block_number
 AND tx.transaction_hash = ar.transaction_hash;
```

The result was the dullest possible table, which is exactly why it matters:

```text
txs        one_author_read_txs   zero_author_read_txs   multi_author_read_txs   author_reads
2924395    2924395               0                      0                       2924395
```

Those reads were **22.47%** of all balance reads on the day. The top fee-recipient address, labelled by block `extra_data` as `Titan (titanbuilder.xyz)`, had **1,448,920** reads across **3,408** blocks. USDT had **295,165** reads across almost every tx-bearing block.

So the top fee recipient was **4.91x** USDT on this surface.

That comparison is a little unfair in a useful way. USDT is hot because user activity keeps touching the contract. The fee recipient is hot because block construction itself fans transaction volume into the same address over and over. A busy builder turns into a balance-read hotspot without being a normal application contract at all.

The top rows for June 21 looked like this:

```text
Titan fee recipient       1,448,920 reads
Quasar fee recipient        740,965
Eureka fee recipient        306,862
USDT contract               295,165
BuilderNet fee recipient    189,060
USDC contract               182,913
WETH contract               133,324
```

There is a write-side echo, but it is not quite as perfectly clean. In `canonical_execution_balance_diffs`, the block-author address appeared **2,911,797** times on the same day, or **99.57%** of the transaction count, and made up **31.59%** of all balance diffs. The read side is exact in this sample; the diff side is close but not identical.

That is the boundary I would keep around the claim. This is a logical execution-instrumentation finding, not a gas-cost claim. Since Shanghai, EIP-3651 warms `COINBASE`, so do not read this chart as "fee recipients are expensive cold balance reads." Also, the builder names come from block `extra_data`, not a formal attribution table. They are good labels for the chart, not identity proof.

The useful mental model is simpler: some hot execution addresses are hot because contracts are popular, and some are hot because the protocol accounting path touches them once for every transaction in blocks they build. Fee-recipient addresses sit in the second bucket. If you are scanning balance-read hotspots and you do not separate them out, builder fee recipients can look like giant application-level state hot spots when they are really block-production plumbing.
