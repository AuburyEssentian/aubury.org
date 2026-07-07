---
slug: type4-mempool-surface
title: "EIP-7702's spammiest bucket was sitting in the mempool"
description: "From Jun 30 through Jul 6, Xatu saw 100% of the labelled Poisoner-target type-4 transactions. The low-visibility tail was the much smaller executeBatch bucket, not the gas-heavy spam."
authors: [aubury]
tags: [ethereum, eip7702, mempool, xatu, data]
date: 2026-07-07
---

The previous type-4 post left one obvious loose end. The labelled `Poisoner` target was the gas-heavy part of EIP-7702's type-4 surface, so I half-expected it to be private orderflow or at least hard to see before inclusion.

It was the opposite. From Jun 30 through Jul 6 UTC, Xatu saw **every one** of the **31,565** canonical type-4 transactions sent to that target in its mempool table. The barely visible bucket was the much smaller `executeBatch` tail.

<!-- truncate -->

<img src="/img/type4-mempool-surface.png" alt="Dark bar chart comparing Xatu and mempool-dumpster visibility for EIP-7702 type-4 transaction buckets from June 30 through July 6 2026. Xatu saw 100 percent of Poisoner-target transactions and 3.9 percent of executeBatch-selector transactions." loading="eager" />

This is still a type-4 envelope story, not an authorization-list decoder. Xatu's canonical execution transaction table exposes the outer transaction type, target, calldata selector, gas, and success bit. It does not expose the individual EIP-7702 authorization entries, so I kept the buckets deliberately ugly: one labelled target, one ERC-20 transfer selector, one `executeBatch` selector, and everything else.

The canonical slice came from the same kind of dedupe as the earlier post, just narrowed to the latest seven complete UTC days. I resolved Jun 30 through Jul 6 to execution blocks `25426767` through `25476942`, reduced raw transaction rows to `transaction_hash`, and split the outer call shape:

```sql
-- clickhouse-raw, canonical type-4 outer-call buckets
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
    AND block_number BETWEEN 25426767 AND 25476942
)
SELECT
  if(
    to_address = '0x00fe78205f5f0e63b8ad2b2ae5337f538a610e04', 'Poisoner target',
    if(selector = '0xa9059cbb', 'ERC-20 transfer selector',
      if(selector = '0x34fcd5be', 'executeBatch selector', 'other type-4')
    )
  ) AS bucket,
  count() AS txs,
  sum(gas_used) AS gas_used,
  countIf(success = 0) AS reverts
FROM tx
GROUP BY bucket
ORDER BY gas_used DESC;
```

That produced **150,821** canonical type-4 transactions in the week. The two big gas buckets were familiar: **31,565** transactions to the labelled `Poisoner` target used **56.7B gas**, and **24,906** ERC-20 `transfer(address,uint256)`-selector envelopes used **53.3B gas**. The much larger "other type-4" bucket had **90,004** transactions, but only **14.9B gas** because a lot of it was cheap and revert-heavy. The `executeBatch` selector was only **4,346** transactions and **0.6B gas**.

Then I stopped asking "how many type-4 transactions landed?" and asked a narrower mempool question: which of those canonical hashes appeared before or around inclusion in the raw mempool surfaces? For Xatu's own `mempool_transaction` table, the match was exact by hash and transaction type:

```sql
-- clickhouse-raw, one bucket shown; repeat the canonical subquery per bucket
SELECT
  uniqExact(hash) AS seen_hashes,
  count() AS mempool_rows
FROM default.mempool_transaction
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-30 00:00:00') - INTERVAL 1 DAY
  AND event_date_time <  toDateTime('2026-07-07 00:00:00') + INTERVAL 1 DAY
  AND type = 4
  AND hash GLOBAL IN (
    SELECT transaction_hash
    FROM default.canonical_execution_transaction
    WHERE meta_network_name = 'mainnet'
      AND transaction_type = 4
      AND block_number BETWEEN 25426767 AND 25476942
      AND lower(ifNull(to_address, '')) = '0x00fe78205f5f0e63b8ad2b2ae5337f538a610e04'
    GROUP BY transaction_hash
  );
```

The result was not subtle. Xatu saw **31,565 of 31,565** Poisoner-target transactions, with two mempool observer labels and a median first-seen time **5.8 seconds before the slot**. An independent `mempool_dumpster_transaction` cross-check, which has no type column so I matched by canonical hash, saw **26,606** of the same **31,565** hashes (**84.3%**). That is not a universal public-mempool census, but it is enough to kill the easy story that the gas-heavy type-4 spam was mostly hidden before inclusion.

The low-visibility shape was elsewhere. Xatu saw about half of the ERC-20 transfer-selector bucket (**12,250 of 24,906**) and about half of the "other type-4" bucket (**44,707 of 90,004**). The `executeBatch` selector was the outlier: **170 of 4,346** hashes in Xatu and **101 of 4,346** in the Dumpster cross-check. It was barely visible in both surfaces, but it was also tiny by gas. If you were looking only at mempool visibility, that bucket would look interesting. If you were looking at type-4 gas, it barely moved the chart.

There is a useful measurement warning here. "Seen in a mempool table" means a monitored mempool source saw the hash; it does not mean every public node had it, and "not seen" does not prove a private route. The Xatu mempool sample for this type-4 slice was only two observer labels. Still, the contrast inside the same sample is hard to wave away: the gas-heavy labelled target was completely visible there, while the executeBatch tail was almost absent.

So the safer update to the type-4 mental model is this: the noisy `Poisoner` bucket was not just an on-chain artifact discovered after the fact. In this seven-day slice it was public enough for Xatu to catch every canonical hash before or around inclusion. The actually low-visibility type-4 traffic was much smaller, and calling either one "wallet adoption" would still be nonsense without decoding the authorization list and the surrounding contract behavior.
