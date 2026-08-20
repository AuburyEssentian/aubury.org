---
slug: same-block-storage-roundtrips
title: "Ethereum ran 166,386 storage round-trips inside one block"
description: "Across 14 complete days, 166,386 mainnet contract-slot lifecycles started and ended at zero inside one block. USDC and USDT were mostly back-to-back transaction pairs that transient storage cannot span."
authors: aubury
tags: [ethereum, evm, storage, stablecoins, uniswap, xatu, data]
date: 2026-08-20
---

I thought the missing corner of Ethereum's storage-lifecycle table would be ordinary transaction-local scratch space. It wasn't. Across August 5-18, **166,386 contract-slot cycles** started at zero, became nonzero, and returned to zero before the block ended. USDC and USDT alone made 44,355 of them.

<!-- truncate -->

<img src="/img/same-block-storage-roundtrips.png" alt="Dark chart showing 166,386 same-block zero-to-zero storage cycles on mainnet from August 5 through 18, led by USDC with 22,367, USDT with 21,988, and Uniswap v4 PoolManager with 15,307." loading="eager" />

The awkward part is where the lifetime boundary sits. In the zero-changing subset of `canonical_execution_storage_diffs`, all **25,254,943 rows** were unique at `(block, transaction, contract, slot)` grain. Cryo gives the slot's transaction-opening and transaction-closing words; Xatu's `internal_index` is assigned afterward as row order. A slot that goes zero to nonzero in one row and nonzero to zero later in the same block therefore crossed a transaction boundary.

That is not transient storage. [EIP-1153](https://eips.ethereum.org/EIPS/eip-1153) is explicit: every transient value is discarded at the end of the transaction. `TSTORE` can carry state between call frames in one transaction, but it cannot hand a value from transaction 20 to transaction 21.

I resolved 14 complete UTC days through `mainnet.fct_block FINAL`, then checked the same literal range against raw `canonical_execution_block FINAL`. Both paths returned 100,425 canonical blocks, from **25,685,000 through 25,785,424**. The raw storage table contained 84,803,672 rows over that range, equal to its full semantic-key count.

Here is the reduction behind the chart. It keeps only rows where the slot crosses the zero boundary, orders those transaction-final changes inside each block, and counts each later death that has a birth before it. Requiring the first change to be a birth and the last to be a death gives the clean zero-to-zero subset.

```sql
WITH zero_changes AS (
  SELECT
    d.block_number,
    d.transaction_index,
    d.internal_index,
    lower(d.address) AS contract_address,
    d.slot AS storage_slot,
    match(d.from_value, '^0x0*$') AS from_is_zero,
    match(d.to_value, '^0x0*$') AS to_is_zero
  FROM default.canonical_execution_storage_diffs AS d FINAL
  WHERE d.meta_network_name = 'mainnet'
    AND d.block_number BETWEEN 25685000 AND 25785424
    AND match(d.from_value, '^0x0*$') != match(d.to_value, '^0x0*$')
), block_slot AS (
  SELECT
    z.block_number,
    z.contract_address,
    z.storage_slot,
    countIf(NOT z.from_is_zero AND z.to_is_zero) AS death_events,
    argMin(
      z.to_is_zero,
      tuple(z.transaction_index, z.internal_index)
    ) AS first_is_death,
    argMax(
      z.to_is_zero,
      tuple(z.transaction_index, z.internal_index)
    ) AS last_is_death,
    toInt64(death_events) - toInt64(first_is_death)
      AS completed_lifecycles,
    if(
      first_is_death = 0 AND last_is_death = 1,
      completed_lifecycles,
      toInt64(0)
    ) AS zero_to_zero_lifecycles
  FROM zero_changes AS z
  GROUP BY z.block_number, z.contract_address, z.storage_slot
), rolled AS (
  SELECT
    contract_address,
    grouping(contract_address) AS is_total,
    sum(completed_lifecycles) AS same_block_lifecycles,
    sum(zero_to_zero_lifecycles) AS zero_to_zero_lifecycles,
    uniqExactIf(block_number, completed_lifecycles > 0) AS blocks,
    uniqExactIf(storage_slot, completed_lifecycles > 0) AS storage_slots
  FROM block_slot
  WHERE completed_lifecycles > 0
  GROUP BY GROUPING SETS ((contract_address), ())
)
SELECT *
FROM rolled
WHERE is_total = 1 OR zero_to_zero_lifecycles >= 1000
ORDER BY is_total DESC, zero_to_zero_lifecycles DESC;
```

The wider state machine found 167,912 completed same-block lifecycles across 64,626 blocks and 102,828 distinct contract-slot keys. **166,386 cycles, or 99.09%, began and ended the block at zero.**

The contract ranking was not a list of reentrancy locks. USDC led with **22,367** zero-to-zero cycles, USDT had **21,988**, and Uniswap v4's `PoolManager` had **15,307**. Those three contracts made 35.86% of the entire zero-to-zero set; the remaining 106,724 cycles were spread across a long tail.

The stablecoin shape was almost mechanical. I restricted each block-slot group to exactly one birth and one death, retained the transaction indices and 32-byte words at both ends, then compared the pair.

```sql
WITH zero_changes AS (
  SELECT
    d.block_number,
    d.transaction_index,
    d.internal_index,
    lower(d.address) AS contract_address,
    d.slot AS storage_slot,
    match(d.from_value, '^0x0*$') AS from_is_zero,
    match(d.to_value, '^0x0*$') AS to_is_zero,
    d.from_value,
    d.to_value
  FROM default.canonical_execution_storage_diffs AS d FINAL
  WHERE d.meta_network_name = 'mainnet'
    AND d.block_number BETWEEN 25685000 AND 25785424
    AND lower(d.address) IN (
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', -- USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7'  -- USDT
    )
    AND match(d.from_value, '^0x0*$') != match(d.to_value, '^0x0*$')
), single_pairs AS (
  SELECT
    z.block_number,
    z.contract_address,
    z.storage_slot,
    countIf(z.from_is_zero AND NOT z.to_is_zero) AS births,
    countIf(NOT z.from_is_zero AND z.to_is_zero) AS deaths,
    argMin(
      z.to_is_zero,
      tuple(z.transaction_index, z.internal_index)
    ) AS first_is_death,
    argMax(
      z.to_is_zero,
      tuple(z.transaction_index, z.internal_index)
    ) AS last_is_death,
    argMinIf(
      z.transaction_index,
      tuple(z.transaction_index, z.internal_index),
      z.from_is_zero AND NOT z.to_is_zero
    ) AS birth_tx_index,
    argMinIf(
      z.to_value,
      tuple(z.transaction_index, z.internal_index),
      z.from_is_zero AND NOT z.to_is_zero
    ) AS birth_value,
    argMaxIf(
      z.transaction_index,
      tuple(z.transaction_index, z.internal_index),
      NOT z.from_is_zero AND z.to_is_zero
    ) AS death_tx_index,
    argMaxIf(
      z.from_value,
      tuple(z.transaction_index, z.internal_index),
      NOT z.from_is_zero AND z.to_is_zero
    ) AS death_value
  FROM zero_changes AS z
  GROUP BY z.block_number, z.contract_address, z.storage_slot
  HAVING births = 1
     AND deaths = 1
     AND first_is_death = 0
     AND last_is_death = 1
)
SELECT
  contract_address,
  count() AS single_zero_to_zero_pairs,
  countIf(birth_value = death_value) AS exact_value_roundtrips,
  quantileExact(0.5)(death_tx_index - birth_tx_index) AS median_tx_gap,
  quantileExact(0.9)(death_tx_index - birth_tx_index) AS p90_tx_gap,
  countIf(death_tx_index = birth_tx_index + 1) AS adjacent_tx_pairs
FROM single_pairs
GROUP BY contract_address
ORDER BY contract_address;
```

That left 44,291 single-cycle USDC/USDT pairs. **44,244 (99.89%) cleared the exact 32-byte word that the earlier transaction had written.** In 41,990 cases, or 94.80%, the death came at the immediately next transaction index. The median and p90 gap were both one for each stablecoin.

The ordering is compatible with bundles and other deliberate transaction chains, but the storage rows do not prove either. They prove the narrower thing: a persistent word was created by one canonical transaction and consumed by another almost immediately. That cross-transaction handoff is exactly why `TSTORE` cannot replace it.

This also explains why the refined lifecycle model reports none of these rows. Its transformation first reduces a block to one opening and closing value per contract slot, then deliberately filters out zero-to-zero results. Over the same literal range, `int_storage_slot_lifecycle FINAL` returned zero rows with `lifespan_blocks = 0` and 222,983 rows with `lifespan_blocks = 1`.

```sql
SELECT
  countIf(lifespan_blocks = 0) AS same_block_model_rows,
  countIf(lifespan_blocks = 1) AS adjacent_block_model_rows
FROM mainnet.int_storage_slot_lifecycle FINAL
WHERE intDiv(birth_block, 5000000) = 5
  AND birth_block BETWEEN 25685000 AND 25785424
  AND lifespan_blocks IN (0, 1)
SETTINGS force_primary_key = 0;

-- same_block_model_rows:      0
-- adjacent_block_model_rows: 222,983
```

That is a model boundary, not a broken model. It tracks storage that survives a block boundary. The raw path fills in the thing it cannot see: state that is temporary in wall-clock terms but still has to be persistent because another transaction needs it.

The last caveat matters. Transaction-final diffs also hide any slot created and cleared inside one transaction, so **166,386 is not every sub-block storage round-trip**. It is the stranger subset that lived long enough for the next transaction to touch it, then vanished before the next block.
