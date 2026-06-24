---
slug: erc20-homoglyph-leaderboard
title: The ERC-20 leaderboard has a Unicode lookalike problem
description: In seven complete UTC days, 19 Unicode USDT/USDC/ETH lookalike contracts emitted 4.86M unique ERC-20 Transfer logs, nearly matching real USDC, from only 47.7k transactions.
authors: aubury
tags: [ethereum, erc20, xatu, data]
date: 2026-06-24
---

The per-contract ERC-20 transfer leaderboard looks sane for about three rows. USDT is first, USDC is second, WETH is third, and then individual tokens whose names look like `USDT`, `USDC`, and `ETH` start showing up. Aggregated as a family, those lookalikes belong above WETH.

From June 17 through June 23 UTC, **19 Unicode lookalike contracts** in the top-50 ERC-20 event sources emitted **4,858,242 unique `Transfer` logs**. Real USDC emitted **4,929,166**. The lookalikes got almost the same event count from **47,703 transactions**, while USDC needed **1,596,999 transactions**.

<!-- truncate -->

<figure>
  <img src="/img/erc20-homoglyph-leaderboard.png" alt="Dark chart showing that 19 Unicode USDT, USDC, and ETH lookalike ERC-20 contracts emitted 4.86 million unique Transfer logs from June 17 through June 23 2026, almost matching real USDC at 4.93 million." loading="eager" />
</figure>

This is not a value chart. It is not a real token-usage chart. It is the event surface you get if you ask, naively, "which ERC-20 contracts emitted the most `Transfer` logs this week?" The answer is still mostly real stables at the top, but the next layer is noisy as hell.

I counted deduped events, not raw rows. The raw `canonical_execution_erc20_transfers` table had **38,760,900 rows** for the seven-day window, but only **27,498,665 unique events** after deduping on the log identity and transfer fields. That matters because a plain `count()` would make the fake-token problem look even bigger than it is.

```sql
SELECT
  erc20,
  count() AS raw_rows,
  uniqExact(tuple(
    block_number,
    transaction_hash,
    log_index,
    erc20,
    from_address,
    to_address,
    value
  )) AS transfer_events,
  uniqExact(transaction_hash) AS txs,
  uniqExact(to_address) AS recipients,
  uniqExact(from_address) AS senders,
  round(transfer_events / txs, 2) AS events_per_tx,
  round(raw_rows / transfer_events, 3) AS raw_per_event
FROM canonical_execution_erc20_transfers
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25333537 AND 25383756
GROUP BY erc20
ORDER BY transfer_events DESC
LIMIT 50
```

The token metadata was the giveaway. I did not use a block-explorer label for this part; I called the standard ERC-20 `name()` and `symbol()` methods. The weird contracts returned strings like `ÚЅDТ`, `U឵S឵DΤ`, `ÚЅDС`, `ĖTḨ`, `E឵Τ឵H`, and `ꓰТН`. They look harmless in a proportional font. Under the hood they are a mix of combining marks, Cyrillic letters, Greek letters, and other Unicode confusables.

I used a deliberately small classifier: only top-50 ERC-20 event sources, only names/symbols that visually folded to USDT, USDC, or ETH after removing combining marks and mapping the confusables visible in that top-50 set. That caught **19 contracts**. It is conservative, not exhaustive.

Here is the exact group query for that set:

```sql
SELECT
  count() AS raw_rows,
  uniqExact(tuple(
    block_number,
    transaction_hash,
    log_index,
    erc20,
    from_address,
    to_address,
    value
  )) AS transfer_events,
  uniqExact(transaction_hash) AS txs,
  uniqExact(to_address) AS recipients,
  uniqExact(from_address) AS senders,
  uniqExact(erc20) AS contracts,
  round(transfer_events / txs, 2) AS events_per_tx,
  round(raw_rows / transfer_events, 3) AS raw_per_event
FROM canonical_execution_erc20_transfers
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25333537 AND 25383756
  AND erc20 IN (
    '0x647a139b234dcf9f91b1b749993604e715d3acb8',
    '0x859f5617a356394ad543a168d2ee4e393cdf4026',
    '0x7747a622e7a41f53dbaf1d9ca7c0f20387155e37',
    '0x37c5a42dab026ef04534f50f1e9f37a169f09ce4',
    '0x0bc97d9afd717e9517d717d36a7fb449a9daa990',
    '0x2c954898a27d4b5a75957c72a2b87995af3482f0',
    '0x8e99b1b2b0e3578b3c22c325d7074cf3e77b562e',
    '0x5c1fdc53d66033e9cb05e3090b73fcd0263572b4',
    '0x9e82a0fd72f17c74fb75ec03725e54180a1d9cb1',
    '0xa9fefbd368f607ac2ff6da4c970b856af72a0027',
    '0x5ee791a197591809f82e5fe04c24f478f9c517fb',
    '0xe7e15665e4334c70cc6ea0956ddbf33489dab127',
    '0x1aed8c8e8f5ac86800b1e914d797929f0f93f9c1',
    '0xddc29bf1f51dc307ff0f51f25af9339bdac7e1c0',
    '0x48bd90d40318c26327c3a9f6989b95eb9794312b',
    '0xe1d9aebf9741ddf0d49f14087665f01374eb2146',
    '0x543838b852c75561686dfb73ea50a186612f4b00',
    '0x30163150097b364aea666f75437fc327cdda65b5',
    '0x277596916f7c63041ad9ce4c7b7a01a3869e83bb'
  )
```

That returned **6,736,599 raw rows**, **4,858,242 unique transfer events**, **47,703 transactions**, **1,110,604 recipient addresses**, and **19 contracts**. The aggregate `events_per_tx` was **101.84**, because the same transaction can hit several of these contracts. Counting per token/transaction pair, the median transaction emitted **17** lookalike `Transfer` logs, the p99 emitted **406**, and the worst one emitted **653**.

The raw log cross-check landed exactly on the same number:

```sql
SELECT
  count() AS raw_log_rows,
  uniqExact(tuple(
    block_number,
    transaction_hash,
    log_index,
    address,
    topic1,
    topic2,
    data
  )) AS transfer_logs,
  uniqExact(address) AS contracts
FROM canonical_execution_logs
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25333537 AND 25383756
  AND address IN (
    '0x647a139b234dcf9f91b1b749993604e715d3acb8',
    '0x859f5617a356394ad543a168d2ee4e393cdf4026',
    '0x7747a622e7a41f53dbaf1d9ca7c0f20387155e37',
    '0x37c5a42dab026ef04534f50f1e9f37a169f09ce4',
    '0x0bc97d9afd717e9517d717d36a7fb449a9daa990',
    '0x2c954898a27d4b5a75957c72a2b87995af3482f0',
    '0x8e99b1b2b0e3578b3c22c325d7074cf3e77b562e',
    '0x5c1fdc53d66033e9cb05e3090b73fcd0263572b4',
    '0x9e82a0fd72f17c74fb75ec03725e54180a1d9cb1',
    '0xa9fefbd368f607ac2ff6da4c970b856af72a0027',
    '0x5ee791a197591809f82e5fe04c24f478f9c517fb',
    '0xe7e15665e4334c70cc6ea0956ddbf33489dab127',
    '0x1aed8c8e8f5ac86800b1e914d797929f0f93f9c1',
    '0xddc29bf1f51dc307ff0f51f25af9339bdac7e1c0',
    '0x48bd90d40318c26327c3a9f6989b95eb9794312b',
    '0xe1d9aebf9741ddf0d49f14087665f01374eb2146',
    '0x543838b852c75561686dfb73ea50a186612f4b00',
    '0x30163150097b364aea666f75437fc327cdda65b5',
    '0x277596916f7c63041ad9ce4c7b7a01a3869e83bb'
  )
  AND topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
```

Result: **4,858,242 unique logs**, **19 contracts**. No mystery row expansion after dedupe. The weirdness is the activity pattern itself.

The split by fake-looking family was lopsided but not one-contract-only: **USDT-like** contracts produced **2.29M** unique logs, **ETH-like** contracts produced **1.38M**, and **USDC-like** contracts produced **1.19M**. Daily volume stayed between **591k** and **858k** lookalike logs all week. This was not one weird block or one isolated airdrop transaction that happened to pollute the ranking.

The practical read is simple: ERC-20 `Transfer` logs are an event shape, not a token-quality filter. If a leaderboard says "top ERC-20 transfers," it may be measuring stablecoin settlement, wallet spam, fake ticker airdrops, exchange churn, or all of those at once. Sorting by event count alone puts a family of Unicode lookalikes almost shoulder-to-shoulder with USDC.

That does not mean those 19 contracts moved anything like USDC's economic value. They almost certainly did not.

It means the leaderboard is easier to spoof than it looks.
