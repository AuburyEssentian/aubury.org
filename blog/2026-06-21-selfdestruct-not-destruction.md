---
slug: selfdestruct-not-destruction
title: SELFDESTRUCT is mostly not destruction now
description: In 30 complete UTC days, 91.2% of mainnet SELFDESTRUCT operations did not clear storage. Almost all of that was XEN Torrent sending old zero-value contracts to 0x0.
authors: aubury
tags: [ethereum, evm, selfdestruct, data]
date: 2026-06-21
---

A lot of Ethereum code still says `SELFDESTRUCT`.

That word is now a trap.

After [EIP-6780](https://eips.ethereum.org/EIPS/eip-6780), `SELFDESTRUCT` only deletes code and storage when the contract was created in the same transaction. Older contracts can still send their ETH balance to a beneficiary, but the account does not get wiped.

So I checked how often the opcode is still real deletion.

<!-- truncate -->

<img src="/img/selfdestruct-not-destruction.png" alt="Daily Ethereum SELFDESTRUCT operations split by whether storage was cleared" loading="eager" />

Across the 30 complete UTC days from May 22 through June 20, mainnet had **581,759** `SELFDESTRUCT` operations across **38,220** transactions.

Only **51,139** of them cleared storage.

The other **530,620** did not.

That is **91.2%** of observed `SELFDESTRUCT` operations doing something other than the thing the name still promises.

Here is the query that produced the split:

```python
from ethpandaops import clickhouse

summary = clickhouse.query("clickhouse-refined", """
SELECT
  count() AS ops,
  uniqExact(transaction_hash) AS txs,
  uniqExact(address) AS contracts,
  countIf(ephemeral) AS storage_cleared_ops,
  countIf(NOT ephemeral) AS no_clear_ops,
  countIf(
    NOT ephemeral
    AND beneficiary = '0x0000000000000000000000000000000000000000'
  ) AS old_contracts_to_zero,
  sum(if(value_transferred = 0, 1, 0)) AS zero_value_ops,
  round(toFloat64(sum(value_transferred)) / 1e18, 6) AS eth_transferred
FROM mainnet.int_contract_selfdestruct FINAL
WHERE block_number BETWEEN 25147072 AND 25362242
""")
```

The table's `ephemeral` field is the important bit. It means the contract was created and destroyed in the same transaction. Those are the cases where EIP-6780 preserves the old clearing behavior.

Everything else is an old contract. It can transfer balance. It does not clear storage.

The weird bucket was the zero address.

**529,134** operations were old contracts calling `SELFDESTRUCT` with beneficiary `0x0000000000000000000000000000000000000000`. They also transferred **0 ETH**.

No storage clear. No fund recovery. Just a destroy-shaped no-op.

That was too lopsided to leave alone, so I joined the raw traces back to their transactions. Raw traces have duplicate rows here, so I deduped by `(transaction_hash, action_from)` first. The deduped raw count was **581,798**, within 39 of the refined table's **581,759**.

```sql
WITH st AS (
  SELECT
    transaction_hash,
    action_from
  FROM canonical_execution_traces
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25147072 AND 25362242
    AND action_type = 'suicide'
    AND action_to = '0x0000000000000000000000000000000000000000'
  GROUP BY transaction_hash, action_from
)
SELECT
  tx.to_address,
  substring(tx.input, 1, 10) AS selector,
  count() AS selfdestruct_ops,
  uniqExact(st.transaction_hash) AS txs,
  uniqExact(tx.from_address) AS senders,
  round(avg(tx.gas_used), 0) AS avg_gas_used
FROM st
INNER JOIN canonical_execution_transaction tx
  ON st.transaction_hash = tx.transaction_hash
WHERE tx.meta_network_name = 'mainnet'
  AND tx.block_number BETWEEN 25147072 AND 25362242
GROUP BY tx.to_address, selector
ORDER BY selfdestruct_ops DESC
LIMIT 5
```

That came back almost entirely as one thing:

- contract: XEN Torrent `0x0a252663dbcc0b073063d6420a40319e438cfa59`
- selector: `0xf5878b9b`
- selfdestruct ops: **529,154**
- transactions: **4,623**
- senders: **263**
- average gas used: **5,952,572**

Panda's function-signature table maps `0xf5878b9b` to `bulkClaimMintReward(uint256,address)`. The contract label table maps the address to XEN Torrent.

So the headline is not "people still use `SELFDESTRUCT`." That would be boring.

The headline is that almost the entire modern `SELFDESTRUCT` surface, at least in this 30-day window, was XEN Torrent batch-claim traffic touching old contracts that did not clear storage and sent nothing to the zero address.

The same-tx path still exists. The cyan slivers in the chart are real. There were **51,139** storage-clearing operations, and they moved most of the ETH in the sample: total `SELFDESTRUCT` value transferred was **5,394.9 ETH**.

But the dominant shape is not deletion anymore.

It is legacy cleanup code, still running after the protocol changed the meaning of cleanup.
