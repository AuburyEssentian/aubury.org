---
slug: balance-reads-prestate-accounts
title: The balance-read table is really a prestate account set
description: "A correction: canonical_execution_balance_reads stores one touched-account prestate record per transaction and address, not one ETH-balance read or BALANCE opcode."
authors: aubury
tags: [ethereum, execution, xatu, panda, data, correction]
date: 2026-07-14
---

I need to correct a noun I used three weeks ago. I called `canonical_execution_balance_reads` logical instrumentation for ETH balance reads. The count was real; the thing being counted was not.

These rows are transaction-account prestate records. They are not `BALANCE` opcodes, repeated balance lookups, or a gas counter.

<!-- truncate -->

<a href="/img/balance-reads-prestate-accounts.png"><img src="/img/balance-reads-prestate-accounts.png?v=20260714" alt="Quasar block 25,525,799 had 1,990 transactions and 1,990 fee-recipient prestate account records, with the recorded balance stepping upward across the block." loading="eager" /></a>

The mistake came from trusting a tidy dataset name. [Xatu asks Cryo for `balance_reads`](https://github.com/ethpandaops/xatu/blob/a83a609259acd353cc0d0625688964efdbc7c5c7/pkg/cannon/deriver/execution/balance_reads.go#L23-L38), and [Cryo gets the data from Geth's `prestateTracer`](https://github.com/paradigmxyz/cryo/blob/559b65455d7ef6b03e8e9e96a0e50fd4fe8a9c86/crates/freeze/src/datasets/balance_reads.rs#L27-L39). [Geth's own description is blunt](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers#prestate-tracer): prestate mode returns the accounts needed to execute a transaction and tracks every part of state that was touched. It returns one object per account, with balance, nonce, code, and storage fields.

[Cryo then walks that account map](https://github.com/paradigmxyz/cryo/blob/559b65455d7ef6b03e8e9e96a0e50fd4fe8a9c86/crates/freeze/src/datasets/balance_reads.rs#L60-L90) and writes one row for an account when the prestate object has a balance. [Xatu stamps `internal_index` after extraction](https://github.com/ethpandaops/xatu/blob/a83a609259acd353cc0d0625688964efdbc7c5c7/pkg/cannon/deriver/execution/balance_reads.go#L154-L163), so that field is row ordering, not an EVM step number. The honest label is ugly but useful: **one transaction-account prestate record**.

The old fee-recipient result survives that correction. On July 13, the canonical transaction table had **2,695,854 transactions** across **7,162 tx-bearing blocks**. The balance table had exactly **2,695,854 fee-recipient prestate rows** in those blocks, and every block matched its transaction count.

I fetched the two block-level sides separately and joined them locally on `block_number`. That avoided turning a big distributed join into the only source of truth:

```sql
-- Transaction denominator
SELECT
  block_number,
  count() AS tx_count,
  uniqExact(transaction_hash) AS unique_txs
FROM default.canonical_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25519988 AND 25527154
GROUP BY block_number;

-- Fee-recipient prestate rows
WITH authors AS (
  SELECT block_number, any(lower(author)) AS author
  FROM default.canonical_execution_block FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25519988 AND 25527154
  GROUP BY block_number
)
SELECT
  r.block_number,
  count() AS author_rows,
  uniqExact(r.transaction_hash) AS author_transactions
FROM default.canonical_execution_balance_reads AS r FINAL
GLOBAL INNER JOIN authors AS b
  ON r.block_number = b.block_number
WHERE r.meta_network_name = 'mainnet'
  AND r.block_number BETWEEN 25519988 AND 25527154
  AND lower(r.address) = b.author
GROUP BY r.block_number;
```

The grain is not just a fee-recipient quirk. In a 200-block all-address check around block 25,525,799, the table had **403,492 rows** and exactly **403,492 unique `(transaction_hash, address)` pairs**. It covered 88,384 transactions and 59,663 addresses without one repeated transaction-address key.

```sql
SELECT
  count() AS rows,
  uniqExact(tuple(transaction_hash, lower(address))) AS unique_tx_addresses,
  uniqExact(tuple(transaction_hash, internal_index)) AS unique_tx_internal_indexes,
  uniqExact(transaction_hash) AS transactions,
  uniqExact(lower(address)) AS addresses
FROM default.canonical_execution_balance_reads FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25525700 AND 25525899;
```

Block 25,525,799 makes the mechanism visible. It had 1,990 transactions and 1,990 prestate records for the Quasar-labelled fee recipient. The recorded balance climbed by **13.683 mETH** between transaction 0 and transaction 1,989 because each row is the account state handed to the next transaction, not another tally of balance operations.

The diff table gives a cleaner cross-check than the chart. Of the 1,990 transactions, 1,987 changed the fee recipient's balance. For all 1,987, `balance_reads.balance` matched that transaction's `balance_diffs.from_value`; for all 1,986 non-final rows with a diff, `balance_diffs.to_value` matched the next transaction's prestate balance. Three transactions still had a prestate row but no balance diff, which is exactly the distinction the old wording blurred.

```sql
-- Fetch both bounded sides, then merge by transaction_index/hash.
SELECT transaction_index, transaction_hash, internal_index, balance
FROM default.canonical_execution_balance_reads FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number = 25525799
  AND lower(address) = '0x396343362be2a4da1ce0c1c210945346fb82aa49'
ORDER BY transaction_index;

SELECT transaction_index, transaction_hash, from_value, to_value
FROM default.canonical_execution_balance_diffs FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number = 25525799
  AND lower(address) = '0x396343362be2a4da1ce0c1c210945346fb82aa49'
ORDER BY transaction_index;
```

So the June post's useful observation remains: a builder fee recipient appears once per transaction and can dominate this table. The bad part was calling those appearances balance reads and comparing addresses as if row count measured repeated read activity.

It does not. This table is much closer to a transaction witness surface than an opcode counter. I patched the old post rather than quietly changing the wording.
