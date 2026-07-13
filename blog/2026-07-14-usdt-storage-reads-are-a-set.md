---
slug: usdt-storage-reads-are-a-set
title: "One transaction made 519 USDT transfers and four fixed-slot records"
description: "Xatu's canonical_execution_storage_reads is a transaction-slot prestate set, not an SLOAD counter. A 519-transfer USDT batch still produced one record for each fixed control slot."
authors: [aubury]
tags: [ethereum, execution-layer, usdt, xatu, data]
date: 2026-07-14
---

One transaction called USDT's `transfer()` function 519 times and emitted 519 `Transfer` logs. Xatu's `canonical_execution_storage_reads` table kept four records for USDT's fixed control slots. That looks broken until you read the extractor: this table is a prestate set, not an SLOAD counter.

<!-- truncate -->

The name `storage_reads` makes `count()` feel like an operation counter. It is not. [Xatu asks Cryo for the `storage_reads` dataset](https://github.com/ethpandaops/xatu/blob/a83a609259acd353cc0d0625688964efdbc7c5c7/pkg/cannon/deriver/execution/storage_reads.go#L23-L31), and [Cryo calls Geth's prestate tracer](https://github.com/paradigmxyz/cryo/blob/559b65455d7ef6b03e8e9e96a0e50fd4fe8a9c86/crates/freeze/src/datasets/storage_reads.rs#L32-L42). Geth describes that tracer as the state needed to execute a transaction: an account map containing a storage map. Cryo then [iterates each `(slot, value)` in that map once](https://github.com/paradigmxyz/cryo/blob/559b65455d7ef6b03e8e9e96a0e50fd4fe8a9c86/crates/freeze/src/datasets/storage_reads.rs#L78-L94).

A map remembers which slot was touched and its prestate value. It does not remember whether the EVM ran `SLOAD` against that slot once or 519 times. Xatu stamps an `internal_index` onto the exported rows afterward, but that index orders the prestate records; it is not an opcode-step counter.

I checked the grain before looking at any contract leaderboard. Across 200 recent canonical blocks, all **444,255 rows** were unique by `(transaction_hash, contract_address, slot)`. Those rows covered 25,085 transactions and 6,125 contracts, with no repeated transaction/contract/slot key:

```sql
SELECT
  count() AS rows,
  uniqExact(tuple(
    transaction_hash,
    contract_address,
    slot
  )) AS unique_transaction_contract_slot_pairs,
  rows - unique_transaction_contract_slot_pairs AS duplicate_pairs,
  uniqExact(transaction_hash) AS transactions,
  uniqExact(contract_address) AS contracts
FROM default.canonical_execution_storage_reads FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25512816 AND 25513015;
```

USDT makes the distinction painfully visible because the 2017 contract reads the same control state on nearly every transfer. Its [verified source](https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7#code) checks whether transfers are paused, whether the sender is blacklisted, whether the contract has been deprecated, and whether its dormant transfer fee should apply. The four fixed slots are the packed owner/paused state at slot 0, `basisPointsRate` at slot 3, `maximumFee` at slot 4, and the packed upgrade/deprecated state at slot 10. The blacklist and balance keys are mappings, so their slot hashes move with the address.

Over 14 complete UTC days, USDT touched 55,533,287 unique transaction/slot pairs. The four fixed controls supplied **22,511,258 records, or 40.5365%** of the table. This is the query behind the split:

```sql
SELECT
  count() AS storage_read_rows,
  uniqExact(tuple(transaction_hash, slot)) AS unique_tx_slot_pairs,
  uniqExact(transaction_hash) AS transactions_touching_usdt,
  countIf(slot IN (
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000000000000000000000000003',
    '0x0000000000000000000000000000000000000000000000000000000000000004',
    '0x000000000000000000000000000000000000000000000000000000000000000a'
  )) AS fixed_control_rows,
  round(fixed_control_rows * 100.0 / storage_read_rows, 4) AS fixed_share_pct,
  countIf(slot =
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) AS owner_paused_rows,
  countIf(slot =
    '0x0000000000000000000000000000000000000000000000000000000000000003'
  ) AS basis_points_rows,
  countIf(slot =
    '0x0000000000000000000000000000000000000000000000000000000000000004'
  ) AS maximum_fee_rows,
  countIf(slot =
    '0x000000000000000000000000000000000000000000000000000000000000000a'
  ) AS upgrade_deprecated_rows,
  countIf(
    slot IN (
      '0x0000000000000000000000000000000000000000000000000000000000000003',
      '0x0000000000000000000000000000000000000000000000000000000000000004',
      '0x000000000000000000000000000000000000000000000000000000000000000a'
    )
    AND value =
      '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) AS zero_control_rows
FROM default.canonical_execution_storage_reads FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25419598 AND 25519987
  AND lower(contract_address) =
    '0xdac17f958d2ee523a2206206994597c13d831ec7';
```

The individual counts were 5,593,204 for slot 0, 5,590,681 for slot 3, 5,590,670 for slot 4, and 5,736,703 for slot 10. Slots 3, 4 and 10 returned zero in every record, giving 16,918,054 zero-valued control records. Slot 0 kept one stable value because the owner address shares that word with the false `paused` flag. A separate storage-diff query found no writes to any of the four slots during the window, and live getter calls still returned `paused = false`, fee rate 0, maximum fee 0, `deprecated = false`, and a zero upgrade address.

Those checks are not pointless. They are the contract's runtime guardrails, and a zero value is the normal path. The trap is calling their table rows SLOAD executions or gas-consuming read operations. The prestate tracer has already thrown that frequency information away.

<a href="/img/usdt-storage-reads-are-a-set.png?v=20260714-0455" target="_blank" rel="noopener noreferrer">
  <img src="/img/usdt-storage-reads-are-a-set.png?v=20260714-0455" alt="Across 14 complete days, four fixed USDT control slots accounted for 22.51 million of 55.53 million unique transaction-slot records. One batch transaction made 519 successful USDT transfer calls and emitted 519 Transfer logs, but the prestate table retained only four fixed control-slot records." loading="eager" />
</a>

<small><a href="/img/usdt-storage-reads-are-a-set.png?v=20260714-0455" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a></small>

The batch transaction is the cleaner proof. I ranked USDT's canonical `Transfer` logs over the same 14 days, then fetched traces and storage rows for the top hashes separately rather than trusting a large distributed join:

```sql
SELECT
  transaction_hash,
  min(block_number) AS block_number,
  count() AS transfer_logs
FROM default.canonical_execution_logs FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25419598 AND 25519987
  AND lower(address) =
    '0xdac17f958d2ee523a2206206994597c13d831ec7'
  AND lower(topic0) =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
GROUP BY transaction_hash
ORDER BY transfer_logs DESC
LIMIT 20;
```

For the winning hash I checked the call and state grains separately:

```sql
SELECT
  countIf(
    lower(substring(ifNull(action_input, ''), 1, 10)) = '0xa9059cbb'
    AND (error IS NULL OR error = '')
  ) AS successful_transfer_calls
FROM default.canonical_execution_traces FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number = 25469213
  AND transaction_hash =
    '0x15a9bc95f27a08480b32580995212f39637a5f0b59847ff7b0ce9340218f79dc'
  AND lower(ifNull(action_to, '')) =
    '0xdac17f958d2ee523a2206206994597c13d831ec7';

SELECT
  count() AS storage_rows,
  uniqExact(slot) AS unique_slots,
  countIf(slot IN (
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000000000000000000000000003',
    '0x0000000000000000000000000000000000000000000000000000000000000004',
    '0x000000000000000000000000000000000000000000000000000000000000000a'
  )) AS fixed_control_rows
FROM default.canonical_execution_storage_reads FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number = 25469213
  AND transaction_hash =
    '0x15a9bc95f27a08480b32580995212f39637a5f0b59847ff7b0ce9340218f79dc'
  AND lower(contract_address) =
    '0xdac17f958d2ee523a2206206994597c13d831ec7';
```

The top transaction, `0x15a9…79dc` in block 25,469,213, had **519 successful `transfer()` traces and 519 `Transfer` logs**. It touched 770 unique USDT storage slots in total because hundreds of sender and recipient balance keys moved through the batch. Yet the four fixed controls appeared once each: four rows, not 2,076. The other 19 top batch transactions behaved the same way, each keeping four fixed records despite 427 to 507 successful transfer calls.

The wider event cross-check tells the same story. USDT emitted **12,821,841 `Transfer` logs** in 5,539,561 transactions during the 14-day window, while every one of its 55,533,287 `storage_reads` rows was a unique transaction/slot pair. The two tables answer different questions. One preserves repeated contract activity; the other preserves the transaction's storage witness shape.

Use `canonical_execution_storage_reads` to ask which slots a transaction needed, how wide its state footprint was, or which prestate values were touched. Do not use it to rank SLOAD frequency, estimate storage-read gas, or count repeated hot-path reads inside a batch. For that, you need an opcode-step trace.

For now, the ugly honest label is **prestate slot records**. `storage_reads` is shorter, but it invites the wrong count.
