---
title: "The December receipt storm: when MEV bots logged 200 hops per swap"
description: "In early December 2025, a cluster of arbitrage bots briefly tripled Ethereum's receipt storage rate — generating 400+ event logs per transaction through hundreds of sequential pool hops. Nobody noticed."
slug: receipt-storm
authors: aubury
tags: [ethereum, mev, receipts, execution-layer]
hide_table_of_contents: false
---

Transaction receipts are one of those parts of Ethereum that node operators silently carry but rarely talk about. Every full node stores every receipt for every transaction ever executed: gas used, status, and — crucially — every event log the transaction emitted. That accumulates fast.

As of March 2026, Ethereum's full receipt history weighs in at **55.5 GB** across roughly 430 days of post-Merge data tracked in EthPandaOps' xatu dataset. Growing at about 1.65 GB per day, it's manageable. But in early December, something broke that trend spectacularly.

<!-- truncate -->

![The December 2025 receipt storm](/img/receipt-storm-dec2025.png)

The chart above tells the story in two panels. The top shows average receipt bytes per block over the past 14 months. The bottom shows event logs emitted per transaction. Both go vertical at the same moment: **December 7, 2025**.

On a normal day, Ethereum transactions emit roughly **2.8 event logs** each. A simple ERC-20 transfer emits one Transfer log. A Uniswap swap through a single pool adds a Sync event and maybe a few more — call it 3-5 logs for a typical DeFi interaction.

On December 7, the network average hit **17.2 logs per transaction**. Six times normal. The average block's receipt payload jumped from ~185 KB to **485 KB**.

---

The culprit wasn't a single spammy token or an airdrop. It was a coordinated cluster of MEV arbitrage bots executing something genuinely unusual: **200-hop swap chains**.

Querying `canonical_execution_logs` for December 7 (blocks 23,957,251–23,964,385), two contracts dominate the log count:

```sql
SELECT address, count() as n_logs, uniq(transaction_hash) as n_txs,
       round(count() / uniq(transaction_hash), 2) as logs_per_tx
FROM canonical_execution_logs
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 23957251 AND 23964385
GROUP BY address ORDER BY n_logs DESC LIMIT 5
```

| Contract | Logs | Transactions | Logs/tx |
|---|---|---|---|
| `0x609e0f0c...` | 8,271,602 | 41,241 | **200.6** |
| `0xde228969...` | 4,161,411 | 41,241 | **100.9** |
| `0x0d4a11d5...` (Uni V2 USDT/WETH) | 4,107,361 | 41,635 | **98.6** |
| USDT | 373,092 | 244,633 | 1.5 |
| USDC | 293,581 | 159,846 | 1.8 |

The top two contracts aren't the transaction targets — they're intermediate contracts called internally by the actual bots. Look at the transaction side:

```sql
SELECT t.to_address, count() as n_txs,
       sum(l.log_count) as total_logs,
       round(avg(t.gas_used), 0) as avg_gas
FROM canonical_execution_transaction t
GLOBAL JOIN (
  SELECT transaction_hash, count() as log_count
  FROM canonical_execution_logs
  WHERE ...
  GROUP BY transaction_hash
) l ON t.transaction_hash = l.transaction_hash
WHERE avg_logs_per_tx > 50
ORDER BY total_logs DESC LIMIT 5
```

| To address | Txs | Avg logs/tx | Avg gas |
|---|---|---|---|
| `0x4a72cf6c...` | 26,630 | **408** | 2,812,054 |
| `0xf552f780...` | 20,088 | **402** | 2,718,686 |
| `0xd6b7d72f...` | 1,895 | 391 | 2,629,719 |

The numbers jump out: **2.8 million gas per transaction**. At Ethereum's current 60M gas limit, each such transaction consumes almost 5% of an entire block. And they're emitting 400 logs each.

For comparison: a standard Uniswap V2 swap through a single pool emits roughly 3 logs (Sync + Transfer × 2). To get to 400 logs, you'd need to route through approximately **130-200 liquidity pools** in a single transaction. Each hop emits Sync and Transfer events, and the WETH pair alone (0x0d4a11d5) shows up nearly 100 times per transaction.

---

The callers are a distributed set of ~70-80 wallets, each sending around **370 transactions per day** to these routing contracts. Gas price: **0.3 gwei** — essentially floor price. These aren't competing for mempool inclusion through gas auctions. They're on private order flow, going directly to builders.

```sql
SELECT from_address, count() as n_txs, round(avg(gas_price)/1e9, 2) as avg_gwei
FROM canonical_execution_transaction
WHERE to_address = '0x4a72cf6c611476ad90116bba0b44895d4b014c3f'
  AND block_number BETWEEN 23957251 AND 23964385
GROUP BY from_address ORDER BY n_txs DESC LIMIT 5
```

| Caller | Txs Dec 7 | Avg gwei |
|---|---|---|
| `0x6bb30d38...` | 392 | 0.29 |
| `0x254fd5e6...` | 385 | 0.31 |
| `0xc01b088d...` | 379 | 0.30 |
| `0x1a99a4ca...` | 377 | 0.31 |
| `0xd3529b83...` | 373 | 0.28 |

The pattern is textbook automated searcher behavior. Multiple wallets, near-identical transaction rates, sub-gwei gas prices. These bots were running continuous multi-pool arbitrage cycles — and they were heavy.

By December 7 alone, the two main contracts consumed roughly **47,000 × 2.8M gas = 131.6B gas**. Total available gas that day: **7,200 blocks × 60M = 432B gas**. So this cluster occupied approximately **30% of Ethereum's entire block space** while paying almost nothing in fees.

---

The event lasted from **December 7 to about December 20**, with the peak on December 7 and a gradual taper through the following week. By December 21, logs/tx had returned close to baseline.

Looking at the monthly breakdown:

```sql
SELECT toStartOfMonth(day_start_date) as month,
       round(avg(avg_log_count_per_transaction), 3) as avg_logs_per_tx,
       round(sum(total_receipt_bytes) / 1e9, 1) as total_receipts_gb
FROM mainnet.fct_execution_receipt_size_daily
WHERE day_start_date >= '2025-11-01' AND day_start_date < '2026-02-01'
GROUP BY month ORDER BY month
```

| Month | Avg logs/tx | Total receipts |
|---|---|---|
| November 2025 | 3.0 | 37.2 GB |
| **December 2025** | **5.7** | **61.4 GB** |
| January 2026 | 2.5 | 50.8 GB |

December generated **61.4 GB** of receipt data — 65% more than November. The excess above a typical month: roughly **24 GB**, added to every full node's receipt store that month.

These bots don't exist anymore. By the time the contracts were deployed (around December 5) and fully ramped up (December 7), the arbitrage opportunity had apparently closed by December 20 — likely because prices converged or the profit window was competed away. The contracts have been idle since mid-December.

---

The interesting structural point isn't the bots themselves — MEV is part of the game. It's the **receipt storage externality** they left behind.

Ethereum has no direct cost for event log storage. You pay for gas to emit logs (`375 gas per log topic + 8 gas per byte of data`), but that fee is consumed in the block and doesn't reflect the permanent storage burden placed on every full node. These December transactions were optimized to pay as little as possible: 0.3 gwei × 2.8M gas = about 0.00084 ETH per transaction, or roughly **$3 at 2026 prices**.

Each of those $3 transactions generated ~400 logs × ~200 bytes average = ~80 KB of receipt data stored permanently by every full node on the network.

EIP-7706 (proposed multi-dimensional gas for calldata) and EIP-7523 discussions around log pricing have touched on this asymmetry, but there's no deployed fix. The December storm was a live demonstration of how aggressively underpriced receipts can be exploited — and nobody wrote about it at the time.

---

*Data source: [EthPandaOps xatu](https://github.com/ethpandaops/xatu) — `canonical_execution_logs`, `canonical_execution_transaction`, and the `mainnet.fct_execution_receipt_size_daily` CBT aggregation. Block range 23,957,251–23,964,385 for December 7, 2025. Baseline months: January–November 2025 and January 2026.*
