---
slug: nonce-reads-account-touches
title: "Nonce reads are account touches in disguise"
description: In seven complete UTC days, Xatu's canonical_execution_nonce_reads table had 71.7M rows. 43.2% were reads of nonce=1 accounts, including USDT with 2.69M reads and zero nonce changes.
authors: aubury
tags: [ethereum, execution, xatu, data]
date: 2026-06-30
---

`canonical_execution_nonce_reads` sounds like it should tell you who is using nonces. It mostly tells you which accounts execution had to touch. In the seven complete UTC days from June 23 through June 29, the table had **71.7M nonce-read rows**. **31.0M of them, 43.2%, read nonce = 1**.

<!-- truncate -->

<img src="/img/nonce-reads-account-touches.png" alt="Dark two-panel chart showing that 43.2% of nonce-read rows read nonce=1 accounts, with USDT, USDC, WETH, Uniswap PoolManager, SeaDrop, and Permit2 among the largest nonce=1 read addresses, all with zero nonce-diff rows." loading="eager" />

That `1` is the catch. Since [EIP-161](https://eips.ethereum.org/EIPS/eip-161), contract creation increments the new account's nonce before the init code runs, so a normal deployed contract sits at nonce 1. If USDT appears in `nonce_reads` millions of times with nonce 1, that does not mean USDT is sending millions of transactions. It means execution kept reading the USDT account object while processing calls that touched it.

Here is the first query I used. The nonce tables are keyed by block number rather than timestamp, so I first cut the block range for the seven complete UTC days and then queried reads and diffs inside that range.

```sql
-- Mainnet block range for 2026-06-23 through 2026-06-29 UTC:
-- 25,376,589 through 25,426,766.

SELECT
  count() AS read_rows,
  uniqExact(transaction_hash) AS txs_with_reads,
  uniqExact(address) AS read_addresses,
  countIf(nonce = 0) AS nonce0_rows,
  countIf(nonce = 1) AS nonce1_rows,
  countIf(nonce > 1) AS nonce_gt1_rows,
  round(100 * countIf(nonce = 1) / count(), 2) AS pct_rows_nonce1
FROM canonical_execution_nonce_reads
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25376589 AND 25426766
```

That returned **71,697,821** read rows. There were **0** rows with `nonce = 0`, **30,952,456** rows with `nonce = 1`, and **40,745,365** rows with `nonce > 1`. The same window had **16,384,689** rows in `canonical_execution_nonce_diffs`, so reads outnumbered actual nonce changes by about **4.4x**.

The easy mistake is to sort `nonce_reads` and treat the output like a sender leaderboard. The top of the read table is a mix of high-nonce actors and boring contract-account touches. Titan Builder's fee recipient address was first with **8.10M** reads and **34,399** nonce-diff rows. Binance-labelled EOAs also show up with high nonces and real diffs. That part is at least intuitively nonce-shaped.

Then the contracts arrive.

```sql
WITH reads AS (
  SELECT
    address,
    count() AS read_rows,
    uniqExact(transaction_hash) AS read_txs,
    min(nonce) AS min_nonce,
    max(nonce) AS max_nonce,
    countIf(nonce = 1) AS nonce1_rows
  FROM canonical_execution_nonce_reads
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25376589 AND 25426766
  GROUP BY address
), diffs AS (
  SELECT
    address,
    count() AS diff_rows,
    uniqExact(transaction_hash) AS diff_txs
  FROM canonical_execution_nonce_diffs
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25376589 AND 25426766
  GROUP BY address
)
SELECT
  r.address,
  r.read_rows,
  r.read_txs,
  r.min_nonce,
  r.max_nonce,
  coalesce(d.diff_rows, 0) AS diff_rows
FROM reads r
LEFT JOIN diffs d ON r.address = d.address
WHERE r.max_nonce = 1
ORDER BY r.read_rows DESC
LIMIT 10
```

USDT had **2,691,246** nonce reads, all at nonce 1, and **0** nonce diffs. USDC had **1,808,647** reads and **0** diffs. WETH had **1,227,025** reads and **0** diffs. Uniswap v4 PoolManager, SeaDrop, Universal Router v4, and Permit2 all had the same shape: lots of nonce reads, no nonce changes.

That is not a bug in the contracts. It is also not a bug in the table, at least not from these checks. On June 29, the raw tuple dedupe matched exactly for both tables: `count()` equalled `uniqExact(tuple(block_number, transaction_hash, internal_index, address, nonce))` for reads, and the equivalent diff tuple was also unique. The row is real. The mental model is the thing that needs a warning label.

The useful split is read versus diff. A diff is the account nonce moving, usually the sender paying for a transaction or an account creating contracts. A read is weaker. For contracts, especially nonce-1 contracts, it is often just one more account-field read inside normal execution. Sorting reads by count will surface the accounts everyone touches: USDT, USDC, WETH, Uniswap routers, builder fee recipients, and exchange hot wallets.

That can still be useful. If you want an account-touch heatmap, `nonce_reads` is one more angle on the same hot-path story that balance reads, storage reads, and address appearances tell from different sides. If you want to know who is burning through sender nonces, use `canonical_execution_nonce_diffs`, and keep the read table out of that sentence.
