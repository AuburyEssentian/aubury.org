---
slug: maxeb-1920-eth-deposits
title: Validator deposits are not 32 ETH anymore
description: On June 23, mainnet had 51 exact-1,920 ETH deposit events with 0x02 compounding credentials. They were 13% of deposit events but 83% of deposit ETH.
authors: aubury
tags: [ethereum, staking, maxeb, deposits, data]
date: 2026-06-24
---

I keep seeing the deposit contract treated like a 32 ETH counter. That shortcut broke.

On June 23 UTC, Ethereum had **51 deposit events of exactly 1,920 ETH**. They were only **12.9%** of the day's deposit events, but they carried **97,920 ETH**, or **82.7%** of the ETH that hit the deposit contract.

<!-- truncate -->

<figure>
  <img src="/img/maxeb-1920-eth-deposits.png" alt="Stacked bar chart of mainnet deposit-contract call value from May 25 through June 23 2026, highlighting 51 exact 1,920 ETH calls on June 23 totaling 97,920 ETH." loading="eager" />
</figure>

That number is not random. **1,920 ETH is 60 old 32-ETH validators' worth of stake**. With Electra / [EIP-7251](https://eips.ethereum.org/EIPS/eip-7251), a validator can have a much larger effective balance when it uses compounding withdrawal credentials. The [Electra spec](https://github.com/ethereum/consensus-specs/blob/v1.7.0-alpha.11/specs/electra/beacon-chain.md) still has a **32 ETH minimum activation balance**, but the maximum effective balance is **2,048 ETH** for a compounding validator. So a deposit event is no longer synonymous with "one 32 ETH validator".

The cleanest way to count this was not top-level transactions. Some deposits arrive through batch contracts, so filtering `canonical_execution_transaction.to_address = deposit_contract` misses internal calls. I resolved the complete June 23 block range first, then counted value-carrying calls to the deposit contract in the trace table:

```sql
SELECT
  count() AS deposit_calls,
  uniqExact(transaction_hash) AS txs,
  round(sum(action_value) / 1e18, 3) AS eth_total,
  countIf(action_value = 32000000000000000000) AS calls_32_eth,
  round(sumIf(action_value, action_value = 32000000000000000000) / 1e18, 3) AS eth_32,
  countIf(action_value = 1920000000000000000000) AS calls_1920_eth,
  round(sumIf(action_value, action_value = 1920000000000000000000) / 1e18, 3) AS eth_1920,
  countIf(action_value > 32000000000000000000
          AND action_value != 1920000000000000000000) AS calls_other_gt32,
  round(sumIf(action_value,
              action_value > 32000000000000000000
              AND action_value != 1920000000000000000000) / 1e18, 3) AS eth_other_gt32,
  countIf(action_value > 0 AND action_value < 32000000000000000000) AS calls_lt32,
  round(sumIf(action_value,
              action_value > 0
              AND action_value < 32000000000000000000) / 1e18, 3) AS eth_lt32
FROM canonical_execution_traces
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25376589 AND 25383756
  AND action_to = '0x00000000219ab540356cbb839cbe05303d7705fa'
  AND action_type = 'call'
  AND action_value > 0
  AND (error IS NULL OR error = '')
```

That returned **394** deposit-contract calls across **218** transactions, carrying **118,411.102 ETH** total. The ordinary exact-32 ETH deposits were still there: **296 calls**, **9,472 ETH**. But the 51 exact-1,920 ETH calls dwarfed them. The remaining non-32 calls made up another **10,926.351 ETH**, plus a small **92.751 ETH** tail below 32.

I cross-checked the ETH total against `canonical_execution_balance_diffs` for the deposit contract address. Same answer: **118,411.102 ETH** of positive balance diffs. The top-level transaction-value filter only saw **102,824.749 ETH**, which is the trap. It missed **15,586.353 ETH** that reached the deposit contract through internal calls.

Then I decoded the `DepositEvent` logs for the same block range. The deposit contract's event data is awkward old ABI: dynamic `bytes` fields for pubkey, withdrawal credentials, amount, signature, and index. The amount is little-endian gwei. The only decoding trick that matters for this post is:

```python
amount_gwei = int.from_bytes(amount_bytes, "little")
credential_prefix = withdrawal_credentials.hex()[:2]
```

The decoded logs matched the trace count: **394** logs from **218** transactions. They had **391** unique pubkeys. The withdrawal-credential prefixes split like this: **294** were `0x01`, **93** were `0x02`, and **7** were old `0x00` credentials. Every one of the **51 exact-1,920 ETH** deposits used `0x02` compounding credentials.

That matters because a naive dashboard can now be wrong in two different directions. If you count deposit events, June 23 looks like **394** deposits. If you divide deposit ETH by 32, it looks like **3,700.35** old-style validator units. Neither describes the actual shape. The 1,920 ETH chunk alone is **3,060** old-style 32 ETH units behind **51** pubkeys.

This is also not an immediate active-validator count. Electra changed the deposit path so deposits enter the pending-deposit machinery and are processed under churn limits. The execution-layer deposit event says stake entered the deposit contract with a pubkey and credentials; it does not say the validator became active in that same block.

The better mental model is simpler and uglier: the deposit contract is now a stake intake pipe, not a validator counter. A `DepositEvent` can be 1 ETH, 32 ETH, 128 ETH, 1,920 ETH, or something else. If the question is validator count, decode the logs and join forward into validator state. If the question is ETH flow, use traces or balance diffs, not just top-level transaction value.

The old 32 ETH shortcut was convenient. MaxEB made it stale.