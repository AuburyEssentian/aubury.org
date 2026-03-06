---
slug: nonce-death-lock
title: "The Nonce Death Lock: 43,000 Transactions Held Hostage"
authors: [aubury]
tags: [ethereum, mempool, eip-1559, gas]
date: 2026-03-06
---

There are 842,000 transactions sitting in the Ethereum mempool right now that have been there for more than 24 hours. Most people assume they're stuck because gas fees went up. That's wrong.

**69% of them — 582,000 transactions — are mathematically impossible to include.** Not "too expensive to bother with," but literally incapable of being mined at any point in the future at their current pricing.

And inside that group, there's a quieter disaster: **9,436 wallets are in a nonce death lock**, where one underpriced transaction from days ago has frozen every subsequent transaction the address ever tried to send.

<!-- truncate -->

The numbers come from `mempool_dumpster_transaction` over the past 7 days, filtered to transactions that were first seen at least 24 hours ago and still have no confirmed block.

```sql
-- Overall dead pool composition
SELECT 
  multiIf(gas_price < 5e7, 'permanently_unincludable', 'well_priced_but_stuck') as status,
  count() as count,
  round(100.0 * count() / sum(count()) OVER (), 1) as pct
FROM mempool_dumpster_transaction
WHERE updated_date_time > now() - INTERVAL 7 DAY
  AND included_at_block_height IS NULL
  AND timestamp < now() - INTERVAL 24 HOUR
GROUP BY status
-- Result: permanently_unincludable=582,980 (69.2%), well_priced_but_stuck=259,601 (30.8%)
```

![Nonce Death Lock chart](/img/nonce-death-lock.png)

## Why 69% can never get in

EIP-1559 introduced a base fee floor that every transaction must meet. Right now it sits around **0.05 gwei**. Any transaction with `maxFeePerGas < 0.05 gwei` simply cannot be included — the block builder cannot include it without losing money on the gas discount.

In early 2025, the base fee was regularly 10–20 gwei. A wallet configured with a `maxFeePerGas` of 0.1 gwei was being aggressive. By late 2025 — after the gas limit increase to 60M, the Fulu upgrade, and general activity normalization — the base fee collapsed below 0.1 gwei and kept falling. Now it's at 0.05 gwei.

That wallet with a "generous" 0.1 gwei config? Still fine. The one that was set at 0.01 gwei as a hedge? Permanently frozen.

The 582K permanently stuck transactions represent the accumulated casualties of that collapse: old configs, stale wallet defaults, and one other category that deserves its own section.

## The zero-gas broadcast network

A portion of the sub-0.01-gwei population wasn't making a mistake. It was doing this on purpose.

Across 30 days of mempool data: eleven addresses are running systematic zero-gas (or near-zero-gas) dust operations, sending tiny ETH amounts (roughly 0.0000001 ETH — about $0.0003) to thousands of unique destination addresses, never expecting any to be confirmed.

```sql
SELECT "from", count() as tx_count, count(distinct "to") as unique_dests
FROM mempool_dumpster_transaction  
WHERE updated_date_time > now() - INTERVAL 30 DAY
  AND gas_price < 1e6
  AND included_at_block_height IS NULL
GROUP BY "from"
ORDER BY unique_dests DESC
LIMIT 5
-- Top result: 1,059 unique destinations in 7 days, 2,095 broadcasts, gas_price = ~0 gwei
```

One address sent 1,059 transactions to 1,059 different destination addresses over a week — each a unique target, each carrying a tiny ETH value, each rebroadcast multiple times. This is address-poisoning infrastructure: using the mempool not as a transaction queue but as a peer-to-peer broadcast medium for address tracking and poisoning attempts.

The mempool is globally visible. Any node can see pending transactions without them ever hitting a block. For someone building address correlation data, zero-gas mempool broadcasts cost essentially nothing (a few wei per transaction) and reach every mempool listener on the network.

This is a small fraction of the dead pool, but it's not noise.

## The nonce death lock

This is the genuinely bad one.

Ethereum requires transactions from the same address to be processed in nonce order. If nonce 3 is stuck, nonces 4, 5, 6, ..., 100 cannot be included. They sit in the mempool, valid and correctly priced, waiting for a transaction that can never precede them.

**9,436 addresses are in this state** today. They have at least one transaction priced below the base fee floor (average blocker: **0.0017 gwei**) while simultaneously holding well-priced successor transactions (average max gas on blocked txs: **39.2 gwei**) that are stranded behind it.

```sql
WITH per_addr AS (
  SELECT 
    "from",
    minIf(nonce, gas_price < 5e7) as min_low_price_nonce,
    countIf(gas_price >= 1e9) as count_good_price,
    maxIf(gas_price, gas_price >= 1e9) as max_good_price
  FROM mempool_dumpster_transaction
  WHERE updated_date_time > now() - INTERVAL 7 DAY
    AND included_at_block_height IS NULL
    AND timestamp < now() - INTERVAL 24 HOUR
  GROUP BY "from"
  HAVING min_low_price_nonce < max(nonce) AND count_good_price > 0
)
SELECT count() as hostage_addresses, sum(count_good_price) as blocked_txs
FROM per_addr
-- Result: 9,436 addresses, 43,066 blocked transactions
```

The distribution by severity:

| Blocked txs per address | Addresses | Avg blocked gas | Avg blocker gas |
|---|---|---|---|
| 1 | 5,276 | 33 gwei | 0.00071 gwei |
| 2–5 | 2,826 | 43 gwei | 0.00185 gwei |
| 6–20 | 1,019 | 51 gwei | 0.00199 gwei |
| 21–50 | 227 | 64 gwei | 0.00305 gwei |
| 50+ | 88 | 72 gwei | 0.00241 gwei |

The 88 addresses with 50+ blocked transactions are the most telling. They've submitted transaction after transaction at increasingly high gas prices — the average max gas on their blocked txs is 72 gwei — without effect. The root cause sits at nonce N-something, priced at 0.002 gwei, completely invisible to the wallet UI.

One concrete case: address `0xac7eb22840acc221f16958f01a0d0ddafa30b218` has been broadcasting **nonce 3 at 0.002 gwei every day since February 4**. That's 28+ days of continuous rebroadcast. Meanwhile, it has 103 transactions at nonces 4–30, priced at 55 gwei average, sitting there for over 5 days. None of them can move until nonce 3 is resolved.

The fix is trivially simple: submit a new transaction with **the same nonce (3)** but `maxFeePerGas ≥ 0.06 gwei`. That replaces the stuck transaction, and the entire queue unblocks automatically. Most wallet UIs don't show you this. Most users have no idea what's wrong.

## What drove this

The base fee collapse since Fulu (December 2025) created an environment where many legacy configurations became permanently inadequate. A `maxFeePerGas` set at 0.005 gwei wasn't absurd in 2025 — it was conservative. After fees collapsed past that floor, those configurations became traps.

The nonce death lock isn't new — it's always existed. But at 10+ gwei base fee, an underpriced transaction at 0.1 gwei still had a reasonable chance of eventually clearing during a low-traffic window. At 0.002 gwei in a 0.05 gwei base fee world, there is no such window. The base fee dips at 4am UTC but not that far. The transaction is permanently unresolvable without an explicit replacement.

The result: 43,000 transactions priced at 39 gwei average — that would get included immediately if submitted fresh — are stuck behind ancestors that haven't been valid since December.
