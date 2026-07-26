---
slug: layerzero-one-block-storage
title: "LayerZero kept 52,161 storage slots for one block"
description: "In 14 complete days, ReceiveUln302 and EndpointV2 made 35.9% of Ethereum's adjacent-block storage lifecycles. Raw diffs and traces show the verifier-to-delivery cleanup path."
authors: aubury
tags: [ethereum, layerzero, storage, cross-chain, xatu, data]
date: 2026-07-21
---

I expected Ethereum's shortest-lived storage to be token-account churn: balances created, spent, and gone. USDC and USDT do show up, but neither contract was first. LayerZero's `ReceiveUln302` created **52,161 storage slots** and deleted them in the next execution block.

Its `EndpointV2` added another **24,163**. Together, those two contracts made **76,324 of Ethereum's 212,618 adjacent-block storage lifecycles**, or **35.90%**, across 14 complete days. This was not random garbage. It was a cross-chain message waiting room being filled, checked, moved, and cleared.

<!-- truncate -->

<figure>
  <a href="/img/layerzero-one-block-storage.png">
    <img src="/img/layerzero-one-block-storage.png" alt="Daily one-block Ethereum storage lifecycles from July 6 through July 19 2026, split between LayerZero ReceiveUln302, LayerZero EndpointV2, and all other contracts, with the verifier, commit, and delivery cleanup path below." loading="eager" />
  </a>
  <figcaption>One lifecycle is a storage slot that moved from zero to nonzero, then returned to zero in the next execution block. Counts are slots, not messages, bytes, or gas.</figcaption>
</figure>

The lifecycle table is unusually literal. `birth_block` is the block where a slot moves from zero to nonzero; `death_block` is the reverse. `lifespan_blocks = 1` therefore means adjacent execution blocks, not one transaction and not one write. Of the 76,324 LayerZero pairs, **76,115 were 12 seconds apart** and the other 209 crossed a missed slot at 24 seconds.

I resolved the window through finalized canonical blocks before touching the block-partitioned storage model. Refined `mainnet.fct_block FINAL` and raw `canonical_execution_block FINAL` independently returned the same **100,437 blocks and hashes**, from **25,469,764 through 25,570,200**, for July 6-19 UTC.

Here is the query behind the headline. The lifecycle table is ordered by address and slot rather than birth block, so the primary-key guard is deliberately disabled only after pinning the query to one known partition and the literal 14-day block range.

```sql
SELECT
  countIf(lifespan_blocks = 1) AS all_one_block,
  countIf(
    lifespan_blocks = 1
    AND address = '0xc02ab410f0734efa3f14628780e6e695156024c2'
  ) AS receive_uln_one_block,
  countIf(
    lifespan_blocks = 1
    AND address = '0x1a44076050125825900e736c501f859c50fe728c'
  ) AS endpoint_one_block,
  countIf(
    lifespan_blocks = 1
    AND address IN (
      '0xc02ab410f0734efa3f14628780e6e695156024c2',
      '0x1a44076050125825900e736c501f859c50fe728c'
    )
  ) AS layerzero_one_block
FROM mainnet.int_storage_slot_lifecycle FINAL
WHERE intDiv(birth_block, 5000000) = 5
  AND birth_block BETWEEN 25469764 AND 25570200
SETTINGS force_primary_key = 0;

-- all_one_block:        212,618
-- receive_uln_one_block: 52,161
-- endpoint_one_block:    24,163
-- layerzero_one_block:   76,324
```

The first address is a verified [`ReceiveUln302`](https://eth.blockscout.com/address/0xc02ab410f0734efa3f14628780e6e695156024c2). The second is LayerZero's verified [`EndpointV2`](https://eth.blockscout.com/address/0x1a44076050125825900e736c501f859c50fe728c). Their lifecycle shapes are different but both are aggressively temporary. Of 88,502 closed `ReceiveUln302` lifecycles born in the window, **58.94%** died one block later. For `EndpointV2`, it was **24,163 of 27,819 closed lifecycles**, or **86.86%**.

The source code explains the first contract cleanly. [`ReceiveUlnBase._verify`](https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/messagelib/contracts/uln/ReceiveUlnBase.sol) stores a `Verification` record under `(headerHash, payloadHash, DVN)`. Once the configured required and optional DVNs have signed, `_verifyAndReclaimStorage` loops over them and deletes those records. The method name is unusually honest.

The traces reproduce that path without needing to guess from storage keys. The selector `0x0223536e` is `verify(bytes,bytes32,uint64)`: **89,482 successful trace calls wrote exactly 89,482 nonzero storage records** in the receive library. Several calls can share a transaction, which is why those calls covered 89,421 transaction hashes.

Then `commitVerification(bytes,bytes32)` takes over. The deployed [`ReceiveUln302`](https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/ReceiveUln302.sol) reclaims the DVN records and calls `EndpointV2.verify` for the same packet. Across **27,828 successful commit calls**, every transaction contained both sides of that handoff: **88,667 receive-library records were cleared and 27,828 Endpoint payload hashes were written**. That is 3.19 verification records cleared per successful commit, on average.

```sql
SELECT
  action_to,
  substring(action_input, 1, 10) AS selector,
  count() AS trace_rows,
  uniqExact((block_number, transaction_hash, internal_index)) AS exact_trace_rows,
  uniqExact(transaction_hash) AS transactions,
  countIf(error IS NULL OR error = '') AS successful_rows,
  countIf(error IS NOT NULL AND error != '') AS error_rows
FROM default.canonical_execution_traces FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25469764 AND 25570201
  AND action_to IN (
    '0xc02ab410f0734efa3f14628780e6e695156024c2',
    '0x1a44076050125825900e736c501f859c50fe728c'
  )
  AND substring(action_input, 1, 10) IN (
    '0x0223536e', -- ReceiveUln302.verify
    '0x0894edf1', -- ReceiveUln302.commitVerification
    '0xa825d747', -- EndpointV2.verify
    '0x0c0c389e'  -- EndpointV2.lzReceive
  )
GROUP BY action_to, selector
ORDER BY action_to, selector;
```

I fetched the bounded raw storage diffs separately and joined them to those trace transaction hashes locally. That avoids pretending two large distributed raw tables will always give a stable publication join. The result was exact: all 27,828 successful commit transactions cleared at least one `ReceiveUln302` record and created one Endpoint hash in the same transaction.

`EndpointV2` keeps that payload hash until delivery. Its [`verify`](https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol#L146-L160) path writes the hash through `_inbound`. Its [`lzReceive`](https://github.com/LayerZero-Labs/LayerZero-v2/blob/9c741e7f9790639537b1710a203bcdfd73b0b9ac/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol#L163-L182) path calls `_clearPayload` before the external application call, specifically to prevent reentrancy. The data shows **27,827 successful `lzReceive` traces and 27,827 Endpoint storage deaths** on those same transaction hashes.

I also ran the headline backward from raw diffs rather than only checking that each model row had some plausible source. For each LayerZero address and slot key, I looked for a raw zero-to-nonzero transition in block `n` and a nonzero-to-zero transition in block `n + 1`. That raw path produced **76,324 pairs**. The lifecycle model produced 76,324, with a 76,324-row intersection and nothing left over on either side.

There is one important blind spot. The lifecycle model first reduces a slot to its opening and closing value inside each block. A slot created and cleared within the same block can finish zero-to-zero and disappear from this particular denominator. These counts describe state that survived across an execution-block boundary; they are not every bit of temporary EVM storage activity. They also do not count cross-chain messages. One committed packet can clear several DVN verification records, which is exactly what happened here.

Still, the ranking changes the mental picture. Short-lived state is not only token balances and AMM locks. In this window, the busiest one-block storage contract was a verifier deliberately writing proof-of-approval records, deleting them, moving one hash into the endpoint, then deleting that hash at delivery. The state churn was real. It just had excellent cleanup discipline.
