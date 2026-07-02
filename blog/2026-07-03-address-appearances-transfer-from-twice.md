---
slug: address-appearances-transfer-from-twice
title: "Token transfer address appearances duplicate the sender"
description: "On July 1, Xatu's canonical_execution_address_appearances table emitted ERC-20 and ERC-721 transfer relationship rows that matched Transfer.from, not Transfer.to."
authors: aubury
tags: [ethereum, execution, tokens, xatu, data]
date: 2026-07-03
---

Some table names quietly lie to you. `canonical_execution_address_appearances` has relationship rows called `erc20_transfer_from` and `erc20_transfer_from_to`, which sounds like it should cover both sides of a token transfer. On July 1, it did something simpler and uglier: it pointed at the sender twice.

<!-- truncate -->

I started with this table because it looked like the broad "who appeared in this transaction?" index that dashboard people always want. That is a useful surface, but only if the relationship names mean what they look like they mean. For token transfers, they do not.

First I resolved the complete July 1 UTC execution-block range, because these raw execution tables are block-number partitioned:

```sql
SELECT
  min(block_number) AS min_block,
  max(block_number) AS max_block,
  count() AS blocks
FROM default.canonical_execution_block
WHERE meta_network_name = 'mainnet'
  AND block_date_time >= toDateTime('2026-07-01 00:00:00')
  AND block_date_time <  toDateTime('2026-07-02 00:00:00');
```

That gave blocks **25,433,939 through 25,441,105**, covering **7,167** canonical execution blocks and **2,238,720** transactions. Then I compared the transfer-shaped relationship rows against the canonical ERC transfer tables for the same block range:

```sql
SELECT
  'address_appearances' AS surface,
  relationship AS name,
  count() AS rows,
  uniqExact(transaction_hash) AS txs
FROM default.canonical_execution_address_appearances
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25433939 AND 25441105
  AND relationship IN (
    'erc20_transfer_from', 'erc20_transfer_from_to',
    'erc721_transfer_from', 'erc721_transfer_from_to'
  )
GROUP BY relationship

UNION ALL

SELECT
  'transfer_table' AS surface,
  'erc20_transfers' AS name,
  count() AS rows,
  uniqExact(transaction_hash) AS txs
FROM default.canonical_execution_erc20_transfers
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25433939 AND 25441105

UNION ALL

SELECT
  'transfer_table' AS surface,
  'erc721_transfers' AS name,
  count() AS rows,
  uniqExact(transaction_hash) AS txs
FROM default.canonical_execution_erc721_transfers
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25433939 AND 25441105;
```

The row counts lined up too neatly to ignore. July 1 had **2,780,877** ERC-20 transfer rows, and `address_appearances` had **2,780,877** `erc20_transfer_from` rows plus **2,780,877** `erc20_transfer_from_to` rows. ERC-721 had the same shape at smaller scale: **172,599** transfer rows, **172,599** `erc721_transfer_from` rows, and **172,599** `erc721_transfer_from_to` rows.

At that point the charitable guess was that `_from_to` meant the recipient side. It does not. I narrowed the test to transactions with exactly one ERC-20 or ERC-721 `Transfer` event, so there was no multi-transfer ambiguity inside the transaction, then joined the address-appearance rows back to the canonical transfer row:

```sql
WITH single AS (
  SELECT
    transaction_hash,
    any(erc20) AS token,
    any(from_address) AS from_address,
    any(to_address) AS to_address
  FROM default.canonical_execution_erc20_transfers
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25433939 AND 25441105
  GROUP BY transaction_hash
  HAVING count() = 1
)
SELECT
  relationship,
  count() AS rows,
  uniqExact(a.transaction_hash) AS txs,
  countIf(a.address = from_address) AS matches_from,
  countIf(a.address = to_address AND from_address != to_address) AS matches_nonself_to,
  round(100 * matches_from / rows, 4) AS pct_from,
  round(100 * matches_nonself_to / rows, 4) AS pct_nonself_to
FROM default.canonical_execution_address_appearances AS a
GLOBAL INNER JOIN single USING (transaction_hash)
WHERE a.meta_network_name = 'mainnet'
  AND a.block_number BETWEEN 25433939 AND 25441105
  AND a.relationship IN ('erc20_transfer_from', 'erc20_transfer_from_to')
GROUP BY relationship
ORDER BY relationship;
```

For the **653,129** single-transfer ERC-20 transactions, both relationship names matched `Transfer.from` **100%** of the time. They matched non-self `Transfer.to` **0%** of the time. Running the same query against `canonical_execution_erc721_transfers` returned the same pattern across **50,774** single-transfer ERC-721 transactions.

<img src="/img/address-appearances-transfer-from-twice.png" alt="Heatmap showing ERC-20 and ERC-721 address-appearance transfer rows matching Transfer.from 100% of the time and non-self Transfer.to 0% of the time" loading="eager" />

A single transaction makes the bug-shaped part easier to see. In `0x0b33ba5384aa9457a8897fa1781ee2963b1d2d0703f00cf2c47411d31d0d5d01`, the canonical ERC-20 transfer row says token `0xa12c...f4f3`, from `0x91d4...debe`, to `0xcc49...0f52`. The raw log agrees: `topic1` is the sender and `topic2` is the recipient.

The address-appearance rows for that same transaction do not include the recipient under the transfer relationship. They include `erc20_transfer_from = 0x91d4...debe` and `erc20_transfer_from_to = 0x91d4...debe`. The recipient can still appear elsewhere in the transaction through some other call or event, but this transfer relationship row is not how you find it.

This is exactly the kind of table that can poison a dashboard without looking broken. If you count `erc20_transfer_from_to` as recipient activity, you are really counting senders again. If you use the table as a general address-touch index, keep the role caveat attached to it and cross-check token movement with `canonical_execution_erc20_transfers`, `canonical_execution_erc721_transfers`, or raw `Transfer` logs.

The safe rule is boring but useful: `canonical_execution_address_appearances` is a relationship-row surface, not a canonical token-transfer participant table. For ERC-20 and ERC-721 recipients on July 1, the transfer tables had the recipient. The address-appearance transfer rows did not.
