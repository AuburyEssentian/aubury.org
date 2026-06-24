---
slug: erc721-mirror-trap
title: The ERC-721 leaderboard had a mirror-token problem
description: In seven complete UTC days, ORE404Mirror emitted 273,448 unique ERC-721 Transfer logs from 740 transactions. It was the busiest ERC-721 event source, but it was a DN404 mirror, not a normal NFT mint.
authors: aubury
tags: [ethereum, erc721, dn404, xatu, data]
date: 2026-06-24
---

The top ERC-721 transfer source last week was not a mint everyone suddenly cared about. It was a mirror contract.

From June 17 through June 23 UTC, `ORE404Mirror` emitted **273,448 unique ERC-721 `Transfer` logs** from **740 transactions**. That made it the busiest ERC-721 event source in Xatu's new execution tables, more than 7x the next contract by deduped event count. The awkward part is that the verified source says exactly what it is: `contract ORE404Mirror is DN404Mirror`.

<!-- truncate -->

<figure>
  <img src="/img/erc721-mirror-trap.png" alt="Dark chart showing ORE404Mirror as the largest ERC-721 Transfer event source from June 17 through June 23 2026, with 273,448 unique logs from 740 transactions and a peak 30% share on June 22." loading="eager" />
</figure>

This is the query I used for the leaderboard. The important bit is the dedupe key. A plain `count()` on the raw table was too high, so I counted unique `(block_number, transaction_hash, log_index, erc721, token)` tuples and cross-checked the result against raw logs.

```sql
SELECT
  erc721,
  uniqExact(tuple(
    block_number,
    transaction_hash,
    log_index,
    erc721,
    token
  )) AS transfer_events,
  count() AS raw_rows,
  uniqExact(transaction_hash) AS txs,
  round(transfer_events / txs, 1) AS events_per_tx,
  uniqExact(to_address) AS recipients,
  uniqExact(from_address) AS senders,
  uniqExactIf(
    tuple(block_number, transaction_hash, log_index, erc721, token),
    from_address = '0x0000000000000000000000000000000000000000'
  ) AS mint_events,
  uniqExact(token) AS tokens
FROM canonical_execution_erc721_transfers
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25333537 AND 25383756
GROUP BY erc721
ORDER BY transfer_events DESC
LIMIT 25
```

That returned **1,778,431** unique ERC-721-shaped transfer events across **603,491** transactions and **5,078** contracts for the seven complete UTC days. ORE404Mirror was first with **273,448** events. The second-place contract, a Uniswap Diamonds / `sEReC20721_diamond_test` contract, had **38,254** events from only **44** transactions. After that the leaderboard looked more like normal mint traffic: SeaDrop clones and small collections in the 18k-23k event range.

The ORE shape was the strange one. Those **273,448** events touched only **3 recipient addresses** and **4 sender addresses** in the deduped table. The median ORE transaction emitted **360** unique ERC-721 `Transfer` logs; the p95 was **384**. It was not thousands of collectors minting one item each. It was a small number of transactions making a mirror contract churn out hundreds of ERC-721-shaped logs at a time.

The raw log check landed on the same number:

```sql
SELECT
  count() AS log_rows,
  uniqExact(tuple(
    block_number,
    transaction_hash,
    log_index,
    address,
    topic0,
    topic1,
    topic2,
    topic3
  )) AS log_events,
  countIf(
    topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  ) AS transfer_topic_rows,
  uniqExactIf(
    tuple(block_number, transaction_hash, log_index, address, topic0, topic1, topic2, topic3),
    topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  ) AS transfer_topic_events,
  uniqExactIf(
    transaction_hash,
    topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  ) AS transfer_topic_txs
FROM canonical_execution_logs
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25333537 AND 25383756
  AND address = '0x84161ecf72829d5b55a9f9c344fb0d34422d4b7a'
```

For ORE404Mirror, that produced **273,448 unique `Transfer`-topic log events** across **740 transactions**, matching the ERC-721 transfer table exactly after dedupe. The raw row counts were higher: **428,104** rows in `canonical_execution_erc721_transfers` and **446,328** raw `Transfer`-topic log rows before dedupe. That is why this post uses unique log identity, not raw row count.

The mechanism matters more than the label. DN404-style tokens intentionally split the world into a base token and an ERC-721 mirror. The mirror emits ERC-721 events, so an event parser is not wrong to pick them up. But if you read an ERC-721 transfer leaderboard as "NFT market activity," this kind of contract will make you lie to yourself. On June 22, ORE404Mirror was **29.6%** of all unique ERC-721 `Transfer` logs in the table. On June 23 it was **0%**. That is bursty mirror mechanics, not a durable shift in NFT demand.

The second outlier makes the same point from a different angle. The Uniswap Diamonds contract emitted **38,254** unique `Transfer` logs from **44 transactions**, about **869 events per transaction**, and involved only **62 token IDs**. So even below ORE, the top of the ERC-721 leaderboard was not a clean list of popular collections. It was partly a list of contracts that batch or mirror state loudly.

The safe query pattern is boring but necessary: dedupe raw rows, count transactions separately, and look at recipient/sender spread before giving the leaderboard a market story. `Transfer(address,address,uint256)` tells you an event shape. It does not tell you whether humans were trading NFTs, a mint contract was distributing supply, or a dual-nature token mirror was screaming into the logs.