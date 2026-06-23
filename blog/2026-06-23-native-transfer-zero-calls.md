---
slug: native-transfer-zero-calls
title: Most native transfers don't transfer ETH
description: Xatu's new canonical_execution_native_transfers table is useful, but the name is a trap. Across seven complete UTC days, 84.08% of rows had value = 0.
authors: aubury
tags: [ethereum, execution, traces, xatu, data]
date: 2026-06-23
---

The new Xatu execution tables are exactly the kind of thing I like: raw enough to be dangerous, tidy enough to query without crying. Then I opened `canonical_execution_native_transfers` and got a very silly-looking leaderboard.

USDT was the top native-transfer recipient.

<!-- truncate -->

That should feel wrong. USDT is an ERC-20 contract. Calling `transfer(address,uint256)` moves USDT balances, not ETH. And yet over the seven complete UTC days from June 16 through June 22, the table had **9,140,093** rows where `to_address` was USDT. Those rows carried **0.029 ETH** total.

The answer is that this table is not an "ETH moved" table unless you filter it that way. It is closer to a call-value observation table. A normal ERC-20 call to USDT has `value = 0`, but it still shows up. A `STATICCALL` to `balanceOf` has `value = 0`, but it still shows up. `DELEGATECALL` can carry `msg.value` in the trace even though the callee does not receive ETH.

Here is the blunt version of the query. First I took complete-day execution block ranges, then counted native-transfer rows inside those ranges:

```sql
WITH tx AS (
  SELECT count() AS txs
  FROM canonical_execution_transaction
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN {min_block:UInt64} AND {max_block:UInt64}
), nt AS (
  SELECT
    count() AS native_transfers,
    countIf(value = 0) AS zero_transfers,
    countIf(value > 0) AS nonzero_transfers,
    uniqExact(transaction_hash) AS txs_with_native_rows,
    uniqExactIf(transaction_hash, value > 0) AS txs_with_nonzero_native,
    sum(toFloat64(value)) / 1e18 AS eth_value
  FROM canonical_execution_native_transfers
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN {min_block:UInt64} AND {max_block:UInt64}
)
SELECT
  tx.txs,
  nt.native_transfers,
  nt.zero_transfers,
  nt.nonzero_transfers,
  round(100 * nt.zero_transfers / nt.native_transfers, 2) AS zero_pct,
  nt.txs_with_native_rows,
  nt.txs_with_nonzero_native,
  round(100 * nt.txs_with_nonzero_native / tx.txs, 2) AS pct_txs_with_nonzero_native,
  round(nt.eth_value, 3) AS eth_value
FROM tx, nt;
```

Across the full seven-day window, mainnet had **16,066,378** canonical transactions and **104,134,997** `native_transfer` rows. **87,552,402** of those rows had `value = 0`, so the weekly zero-value share was **84.08%**. Every transaction had at least one row in the table, but only **59.95%** of transactions had a nonzero-value native row.

<img src="/img/native-transfer-zero-calls.png" alt="Chart showing that most canonical_execution_native_transfers rows are zero-value calls" loading="eager" />

The address leaderboard makes the trap obvious. USDT had more rows than anything else, but only ten nonzero rows in the seven-day sample. USDC was the same shape: **7,335,599** rows, **2** nonzero, **0.013 ETH** total. The unidentified `0x4350…402d` ERC-20 contract sat between them with **7,364,408** rows and one nonzero row.

WETH is the useful contrast. It had **5,144,763** rows and was still **91.99%** zero-value, but the nonzero tail carried **1.29M ETH**. Uniswap v4 PoolManager had **4,757,971** rows, **95.80%** zero-value, and **539k ETH** of nonzero call value. Those contracts really do sit on ETH-flow paths, but their row counts are still mostly ordinary zero-value calls wrapped around token and swap logic.

I cross-checked the shape against `canonical_execution_traces`, because otherwise this could have been a weird derived-table bug. Same block range, same basic story:

```sql
SELECT
  action_type,
  action_call_type,
  count() AS rows,
  countIf(action_value = 0) AS zero_rows,
  countIf(action_value > 0) AS nonzero_rows,
  round(100 * zero_rows / rows, 2) AS zero_pct,
  round(sum(toFloat64(action_value)) / 1e18, 3) AS eth
FROM canonical_execution_traces
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25326351 AND 25376588
  AND action_type IN ('call', 'suicide', 'create', 'reward')
GROUP BY action_type, action_call_type
ORDER BY rows DESC;
```

The trace table had **111,949,652** call/create/selfdestruct rows over the same seven days, and **84.25%** were zero-value. `STATICCALL` was exactly what it sounds like: **21,909,981** rows, all zero. `DELEGATECALL` was more subtle: **20,054,824** rows, **97.22%** zero, with a nonzero `action_value` tail that represents call context rather than ETH paid to the delegate target.

I also joined a 100-block sample back on `(block_number, transaction_hash, internal_index)`. The native rows lined up with trace actions: regular `CALL`, `STATICCALL`, `DELEGATECALL`, `CREATE`, and `SELFDESTRUCT`. A few USDT examples were exactly the boring calls you would expect: `0xa9059cbb` transfers, `0x23b872dd` transferFrom calls, and a pile of `0x70a08231` balanceOf static calls. They are useful execution observations. They are not ETH transfers.

This is the kind of table-name trap that produces very confident nonsense if you skip the unit check. "Top native transfer recipients" sounds like an ETH-flow claim. On this surface, it mostly means "contracts that got called a lot, usually with zero ETH." If you want ETH movement, start with `value > 0`, and be careful with `DELEGATECALL` before pretending the callee received anything.
