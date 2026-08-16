---
slug: identity-precompile-is-busy
title: Ethereum's identity precompile is weirdly busy
description: A 12-day trace window found 4.07 million identity calls, more than any other precompile. A first-touch upper-bound backcast of Draft EIP-7666 adds up to 0.44% to affected receipt gas.
authors: aubury
tags: [ethereum, evm, precompiles, eip-7666, seaport, panda]
date: 2026-08-16
---

A Hegotá proposal would remove a precompile that contracts called an observed **4.07 million times in twelve days**. That sounds reckless until you look at the bill: a first-touch upper-bound backcast of Draft EIP-7666 adds up to **0.44%** to the gas used by the affected transactions.

<!-- truncate -->

Address `0x04` is the identity precompile. Give it bytes and it returns the same bytes, an old EVM trick for copying memory before `MCOPY` existed. [EIP-7666](https://eips.ethereum.org/EIPS/eip-7666) would remove that special client path and install seven bytes of ordinary EVM code at the address instead: `CALLDATASIZE PUSH0 PUSH0 CALLDATACOPY CALLDATASIZE PUSH0 RETURN`.

At ACDE 242, core developers [put EIP-7666 forward for inclusion alongside the Hegotá EVMification work](https://github.com/ethereum/EIPs/pull/12088), then [moved it from Stagnant back to Draft](https://github.com/ethereum/EIPs/pull/12089) on August 11. Proposed for Inclusion starts client review; it is not final fork scope or a mainnet activation. This is a backcast against current calls, not a fork result.

<img src="/img/eip-7666-identity-precompile.png" alt="The identity precompile handled 4.07 million observed internal calls from July 2 through 13, more than any other precompile. A first-touch EIP-7666 upper-bound backcast adds up to 567.9 million gas, or 0.44 percent of affected receipt gas." loading="eager" />

## The busiest precompile, by call count

I froze canonical blocks **25,441,106 through 25,527,154**, covering July 2–13 as twelve complete UTC days. Refined beacon blocks and raw execution blocks agreed on all 86,049 canonical block numbers and both timestamp edges.

One row in `mainnet.int_transaction_call_frame` is one execution call frame. I checked its intended key, `(block_number, transaction_hash, call_frame_id)`, before counting; all 4,068,918 identity rows were unique at that grain. The comparison query was:

```python
precompiles = ",".join(
    f"'0x{i:040x}'" for i in range(1, 18)
)

sql = f"""
SELECT
  lowerUTF8(ifNull(target_address, '')) AS precompile_address,
  count() AS frames,
  uniqExact(transaction_hash) AS transactions,
  sum(gas) AS self_gas
FROM mainnet.int_transaction_call_frame FINAL
WHERE block_number BETWEEN 25441106 AND 25527154
  AND lowerUTF8(ifNull(target_address, '')) IN ({precompiles})
GROUP BY precompile_address
ORDER BY frames DESC
"""
```

Identity came first with **4,068,918 frames in 205,161 transactions**, or 28.70% of calls to mainnet precompile addresses `0x01` through `0x11`. `ECRECOVER` followed at 3.54 million frames and `MODEXP` at 2.99 million; the two observed BLS precompiles had 96 calls each and did not change the ranking. This is call count, not gas consumption: identity used only 123.5 million gas inside the precompile, while the expensive cryptographic precompiles burned far more per call.

The call-frame model had 29,698,032 root frames against 29,700,412 canonical transactions in the same blocks, **99.992% root-transaction coverage**. With that gap, I report 4.07 million as the observed count rather than an exact total; the missing 2,380 roots may still contain identity calls.

There is another useful trap here. `canonical_execution_transaction` found **zero top-level transactions** sent to `0x04`, and the lower-level `canonical_execution_traces` table also returned zero frames whose `action_to` was the identity address. A top-level destination query says nobody uses identity. The dedicated call-frame model says the opposite because every observed use was nested.

## Seaport still uses the old memory-copy trick

The loudest immediate parent was [Seaport 1.6](https://eth.blockscout.com/address/0x0000000000000068F116a894984e2DB1123eB395), which made **1,189,056 identity calls**, 29.22% of the whole `0x04` pile. Its `fulfillAvailableAdvancedOrders` path alone produced 932,152 of them.

This is not address-label guesswork. The source used for the deployed contract defines `IdentityPrecompileAddress = 0x4`, then implements [`MemoryPointerLib.copy()`](https://github.com/ProjectOpenSea/seaport-types/blob/064b12d2007ee86a5bc19469e45ca6f5268ba97b/src/helpers/PointerLibraries.sol#L224-L243) with a `staticcall` that copies `size` bytes from one memory pointer to another. In [one exact Seaport transaction](https://eth.blockscout.com/tx/0xa44cc3d67cf180ba222b06dc110f95f05a01eb59c19b5f89e6d9f6860ee3b09b), the call-frame model found 30 depth-one static calls to identity while filling five advanced orders.

`MCOPY` exists now, but deployed contracts do not rewrite themselves. EIP-7666 can remove the client-side precompile without removing the address-level behavior those contracts expect.

## The repricing is mostly one cold address

The current identity runtime costs `15 + 3 × words`, where `words = ceil(input_bytes / 32)`. EIP-7666's fresh call memory makes the seven-byte replacement cost `13 + 6 × words + floor(words² / 512)`: 13 gas of fixed opcodes, three gas per copied word, and the standard linear-plus-quadratic memory expansion.

I recovered `words` from each observed self-gas value, then calculated the runtime delta at transaction grain. The exact aggregate expression was:

```sql
SELECT
  transaction_hash,
  count() AS calls_in_tx,
  sumIf(
    toInt64(
      13
      + 6 * intDiv(gas - 15, 3)
      + intDiv(
          intDiv(gas - 15, 3) * intDiv(gas - 15, 3),
          512
        )
    ) - toInt64(gas),
    gas >= 15 AND modulo(gas - 15, 3) = 0
  ) AS runtime_extra_gas
FROM mainnet.int_transaction_call_frame FINAL
WHERE block_number BETWEEN 25441106 AND 25527154
  AND lowerUTF8(ifNull(target_address, '')) =
      '0x0000000000000000000000000000000000000004'
GROUP BY transaction_hash;
```

That runtime change adds **54,950,438 gas**. The bigger piece comes from [EIP-2929](https://eips.ethereum.org/EIPS/eip-2929): precompiles start warm today, while ordinary code at `0x04` would normally pay the 2,600-gas cold account access cost on its first touch instead of the 100-gas warm cost. Adding 2,500 gas once per affected transaction contributes another **512,902,500 gas**.

Together, the first-touch upper bound adds **567,852,938 gas** across the window, and the 2,500-gas cold first touch accounts for 90.3% of it. Against 129,186,166,761 gas in the containing transaction receipts, that is **0.4396%**. The median affected transaction rises **0.6128%** and the 95th percentile rises **1.5754%**. Direct Seaport entry transactions move a little more: 0.63% in aggregate and 1.12% at the median.

The 2,500-gas access term is an upper bound because an access list or an earlier account touch may already have warmed `0x04`; the transaction model exposes neither access lists nor opcode-level touches. The runtime calculation excludes 44 three-gas frames whose input length cannot be recovered from the current formula, though I still include each transaction's first-touch charge. I did not replay gas limits, so this backcast cannot identify tight calls that would fail after repricing. It also uses today's opcode schedule rather than a final Hegotá gas table.

## Busy does not mean expensive

The identity precompile is not dead code. It is the busiest precompile by observed internal call count, and one immutable marketplace explains almost a third of the traffic. Those calls are why EIP-7666 preserves the behavior at `0x04` even while removing the precompile.

Millions of calls do not add up to much transaction gas because each one is a cheap memory copy. EIP-7666's phrase "gas costs are slightly different" hides a model that raises identity-related gas to 5.6× today's tiny self-gas bill, but not a 5.6× increase in transaction cost. Most affected transactions land below 2%. The unresolved part is the cold touch: access-list and opcode-level replay should show how often the extra 2,500 gas actually applies.
