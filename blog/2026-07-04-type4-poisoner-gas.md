---
slug: type4-poisoner-gas
title: "Type-4 transactions are already mostly two gas stories"
description: "From Jun 20 through Jul 3, EIP-7702 type-4 transactions were only 0.824% of Ethereum transactions. One labelled Poisoner target and plain ERC-20 transfer calls still consumed 86.5% of type-4 gas."
authors: [aubury]
tags: [ethereum, eip7702, execution, xatu, data]
date: 2026-07-04
---

Type-4 transactions are easy to count and easy to overread. From Jun 20 through Jul 3 UTC, Ethereum had **257,388 deduped type-4 transactions**, which was only **0.824%** of all transactions in the same blocks. That sounds like a small EIP-7702 adoption number until you look at the gas: one address labelled `Poisoner` and a pile of plain ERC-20 `transfer(address,uint256)` calls consumed **86.5%** of type-4 gas.

That is the trap. `transaction_type = 4` tells you the envelope is EIP-7702's set-code transaction type. It does not, by itself, tell you this is a clean smart-wallet action, a user operation, or even something interesting at the authorization-list layer.

<!-- truncate -->

<img src="/img/type4-poisoner-gas.png" alt="Dark stacked-bar chart showing EIP-7702 type-4 transaction count and gas by day, with one labelled Poisoner target and ERC-20 transfer selector consuming most type-4 gas." loading="eager" />

EIP-7702 defines `SET_CODE_TX_TYPE = 0x04`. The outer transaction still has a destination, value, data, access list, and an `authorization_list`. Xatu's `canonical_execution_transaction` table exposes the transaction type and outer call fields, but not the individual authorization-list entries, so I kept the claim deliberately narrow: this is a top-level type-4 envelope and calldata story.

The first check was just the type distribution. I resolved the canonical execution block range for Jun 20 through Jul 3, then deduped raw transaction rows by `transaction_hash` before grouping. That dedupe matters in this window: raw `canonical_execution_transaction` had repeated rows, while the deduped total matched `mainnet.fct_execution_transactions_daily FINAL` exactly at **31,246,133 transactions**.

```sql
-- clickhouse-raw, after resolving Jun 20-Jul 3 UTC to blocks 25355072-25455433
WITH tx AS (
  SELECT DISTINCT
    transaction_hash,
    transaction_type,
    success,
    gas_used,
    from_address,
    to_address
  FROM default.canonical_execution_transaction
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25355072 AND 25455433
)
SELECT
  transaction_type,
  count() AS txs,
  countIf(success = 0) AS reverts,
  round(100 * count() / sum(count()) OVER (), 3) AS pct_of_all_txs,
  round(100 * countIf(success = 0) / count(), 3) AS revert_pct,
  uniqExact(from_address) AS senders,
  uniqExact(to_address) AS targets,
  sum(gas_used) AS gas_used
FROM tx
GROUP BY transaction_type
ORDER BY txs DESC;
```

Type-4 was small by count and weird by shape:

| transaction type | deduped txs | share | revert rate | gas used |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 27,200,967 | 87.054% | 1.525% | 2,593.4B |
| 0 | 3,623,052 | 11.595% | 1.363% | 208.4B |
| **4** | **257,388** | **0.824%** | **5.974%** | **223.1B** |
| 3 | 141,686 | 0.453% | 0.006% | 15.3B |
| 1 | 23,040 | 0.074% | 6.862% | 3.3B |

Then I reused the deduped type-4 rows and bucketed them by the outer call target and selector. This is not an ABI-perfect taxonomy. It is intentionally blunt: the address-label table says one top target is `Poisoner`, `0xa9059cbb` is the ERC-20 `transfer(address,uint256)` selector, and `0x34fcd5be` is `executeBatch((address,uint256,bytes)[])` in the signature table.

```sql
WITH tx AS (
  SELECT DISTINCT
    transaction_hash,
    success,
    gas_used,
    lower(ifNull(to_address, '')) AS to_address,
    ifNull(substring(input, 1, 10), '') AS selector
  FROM default.canonical_execution_transaction
  WHERE meta_network_name = 'mainnet'
    AND transaction_type = 4
    AND block_number BETWEEN 25355072 AND 25455433
)
SELECT
  if(
    to_address = '0x00fe78205f5f0e63b8ad2b2ae5337f538a610e04', 'Poisoner target',
    if(selector = '0xa9059cbb', 'ERC-20 transfer selector',
      if(selector = '0x34fcd5be', 'other executeBatch selector', 'other type-4')
    )
  ) AS bucket,
  count() AS txs,
  sum(gas_used) AS gas_used,
  countIf(success = 0) AS reverts
FROM tx
GROUP BY bucket
ORDER BY gas_used DESC;
```

That split is where the mental model breaks:

| bucket | txs | tx share | gas used | gas share | reverts |
| --- | ---: | ---: | ---: | ---: | ---: |
| labelled `Poisoner` target | 44,084 | 17.13% | 107.6B | 48.24% | 0 |
| ERC-20 `transfer` selector | 43,446 | 16.88% | 85.4B | 38.27% | 41 |
| other `executeBatch` selector | 7,005 | 2.72% | 1.3B | 0.59% | 97 |
| other type-4 | 162,853 | 63.27% | 28.8B | 12.91% | 15,239 |

The labelled Poisoner row is the ugly one. The target `0x00fe...0e04` received **44,084** deduped type-4 transactions from **one sender**, reverted zero times, and used **107.6B gas**. By transaction count it was a large minority. By gas it was almost half the type-4 surface.

The ERC-20 transfer row is the part I did not expect to be that loud. A type-4 envelope can wrap ordinary-looking calldata, and in this window **43,446** type-4 transactions had the plain `transfer(address,uint256)` selector. Those calls used **85.4B gas**, another **38.3%** of type-4 gas. A few were normal labelled tokens like USDT, USDC, WBTC, and USDS, but most of the high-count transfer targets in this slice were unlabeled contracts with one dominant sender. I would not turn that into token-adoption prose without a separate token/value check.

There is a smaller table lesson hiding under the Ethereum one. If I had counted raw transaction rows without deduping, type-4 would have looked like **357,914 rows** instead of **257,388 transactions** in this block range. That is not a subtle rounding error. It is another reason to reduce to the semantic key before writing anything public.

The safer sentence is boring but honest: type-4 transactions were under one percent of Ethereum transactions in these fourteen days, and the gas was dominated by a labelled Poisoner target plus ERC-20 transfer-shaped calls. That is not a wallet-adoption metric. It is a set-code-envelope metric, and it needs to be split by outer call shape before it says much about how people are using EIP-7702.
