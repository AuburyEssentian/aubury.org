---
slug: three-slot-oracle-storage-churn
title: One oracle rewrote three storage slots in most blocks
description: Across seven complete UTC days, a labelled oracle contract changed the same three storage slots in 39,050 transactions, touching 78% of canonical blocks and ranking #22 by raw storage-diff rows.
authors: aubury
tags: [ethereum, execution, storage, oracle, data]
date: 2026-06-25
---

Storage diffs sound like state growth. Sometimes they are just a tiny piece of state getting hammered over and over. Last week one contract labelled `Oracle` changed the same three already-nonzero storage slots **117,150** times, spread across **39,050** transactions. By June 19 it was showing up in about five out of six canonical blocks.

<!-- truncate -->

<figure>
  <a href="/img/three-slot-oracle-storage-churn.png"><img src="/img/three-slot-oracle-storage-churn.png" alt="Dark chart showing a labelled oracle contract with 117,150 storage-diff rows across only three storage slots, plus daily block coverage rising above 83% by June 19 2026." loading="eager" /></a>
</figure>

I got there by looking at `canonical_execution_storage_diffs`, one of the raw Xatu execution tables. This is not a storage-read table, and it is not a state-size table. It records actual slot value changes: address, slot, previous value, new value, transaction hash, and block number.

For the window I used seven complete UTC days, June 17 through June 23. I first bounded that window with `canonical_execution_block`, which gave blocks `25333537` through `25383756`. Then I asked a slightly different question from the normal leaderboard. Not "who has the most writes?" but "who has the most writes per storage slot?"

```sql
SELECT
  address,
  count() AS diff_rows,
  uniqExact(transaction_hash) AS txs,
  uniqExact(block_number) AS blocks_touched,
  uniqExact(slot) AS unique_slots,
  round(count() / uniqExact(slot), 1) AS rows_per_slot,
  countIf(
    from_value = '0x0000000000000000000000000000000000000000000000000000000000000000'
    AND to_value != from_value
  ) AS zero_to_nonzero,
  countIf(
    to_value = '0x0000000000000000000000000000000000000000000000000000000000000000'
    AND from_value != to_value
  ) AS nonzero_to_zero
FROM canonical_execution_storage_diffs
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25333537 AND 25383756
GROUP BY address
HAVING diff_rows >= 50000
ORDER BY rows_per_slot DESC
LIMIT 10;
```

The raw-count leaderboard is exactly what you would expect. USDT was first with **8.27M** storage diffs. USDC was second with **5.58M**. XEN Crypto was third with **2.53M**, because XEN refuses to stop being a state-shape oddity.

The oracle barely shows up in that view. It ranked **#22** by raw storage-diff rows. The density view is where it gets weird: **117,150** rows, **39,050** transactions, **39,050** blocks, and exactly **3** unique storage slots. That is **39,050 writes per slot**. The next contract in the same `>=50k rows` filter was at about **5,194 writes per slot**.

The slot-level check was almost too neat:

```sql
SELECT diffs_per_tx, count() AS txs
FROM (
  SELECT transaction_hash, count() AS diffs_per_tx
  FROM canonical_execution_storage_diffs
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25333537 AND 25383756
    AND address = '0xb02016102e7ab27bce2c3087392098a09c2f0f2a'
  GROUP BY transaction_hash
)
GROUP BY diffs_per_tx
ORDER BY diffs_per_tx;
```

That returned one row: `diffs_per_tx = 3`, `txs = 39050`. No exceptions. All **117,150** diffs were nonzero-to-nonzero updates, so this was not account creation, not storage clearing, and not state growth in the usual "new slots forever" sense. It was three hot slots being rewritten.

The trace side lines up with the same mechanism. Calls into the address were mostly selector `0x49dd1262`, which `mainnet.dim_function_signature` labels as `updatePrices()`. Over the same block range, `canonical_execution_traces` saw **39,838** `updatePrices()` calls across **39,057** transactions, with **7** errored calls. The storage-diff side saw the successful value-changing subset: 39,050 transactions, three diffs each.

```sql
SELECT
  substring(ifNull(action_input, ''), 1, 10) AS selector,
  count() AS calls,
  uniqExact(transaction_hash) AS txs,
  countIf(error IS NOT NULL AND error != '') AS errors,
  avg(result_gas_used) AS avg_result_gas
FROM canonical_execution_traces
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25333537 AND 25383756
  AND lower(ifNull(action_to, '')) = '0xb02016102e7ab27bce2c3087392098a09c2f0f2a'
GROUP BY selector
ORDER BY calls DESC;
```

I am not going to pretend I know whose oracle this is. The contract-owner dimension labels it simply as `Oracle`, and I did not find verified source on Etherscan or Sourcify for that address. That is fine. The interesting part does not require a brand name: a single small update path was rewriting three slots in most blocks, quietly enough that a raw leaderboard buries it under stablecoins and XEN.

The daily shape makes it feel less like a random burst and more like an operating mode. On June 17 the oracle touched **60.7%** of canonical blocks. On June 18 it touched **70.0%**. From June 19 through June 23 it sat around **81-84%**, which is roughly five out of six blocks. Every update transaction still had the same three-diff shape.

This is the distinction I care about. A storage-diff count can mean new state, deleted state, broad application churn, or a tiny hot loop updating the same few slots forever. Those are different costs and different stories. If you only sort by raw rows, you get USDT, USDC, XEN, WETH, routers, pools, all the usual noisy giants. If you sort by writes per slot, a three-slot oracle jumps out of the page.

That does not make it a crisis. It is a small call, and the chain is not falling over because one oracle updates prices a lot. But it is a good reminder that "state writes" is not one thing. Sometimes Ethereum is growing new state. Sometimes it is clearing old state. And sometimes it is just changing the same three words again, and again, and again.
