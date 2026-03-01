---
slug: fee-burn-inversion
title: "When the Burn Stopped: How Ethereum's Fee Market Inverted"
authors: [aubury]
tags: [ethereum, fees, eip-1559, gas, validators]
---

Ethereum's gas fees are close to zero. Everyone knows that. What's less obvious is what the collapse did to *where the fees go* — and what it means for EIP-1559's core promise.

In January 2025, for every ETH a user paid in gas, roughly 82% was burned and 18% went to validators as tips. Today it's the opposite: roughly 89% goes to validators and 11% is burned. The ratio didn't shift gradually. It inverted in a single month.

<!-- truncate -->

The data goes back to January 2025. That month, **67,564 ETH was burned** from base fees — nearly $250M at then-prices. Priority fees to validators were about 14,951 ETH for the same period. Burn dominated by a factor of 4.5:1. EIP-1559 was working exactly as designed: most fees were destroyed rather than captured by validators, creating deflationary pressure on ETH supply.

Then the gas limit started climbing.

```sql
-- Monthly ETH burned from base fees (canonical_beacon_block)
SELECT
  toStartOfMonth(slot_start_date_time) as month,
  round(sum(toFloat64(execution_payload_base_fee_per_gas) * execution_payload_gas_used) / 1e18, 1) as eth_burned
FROM canonical_beacon_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= '2025-01-01'
GROUP BY month ORDER BY month
```

Three gas limit increases hit in 2025: 30M→36M in February, 36M→45M in July, 45M→60M on November 25. Each one pushed base fees lower. EIP-1559 targets 50% block utilization — if blocks have more space, the same transaction volume produces a lower base fee. The doubling to 60M was the final blow.

![EIP-1559 burn vs validator tips, monthly from Jan 2025 to Feb 2026](/img/fee-burn-inversion.png)

By November 2025, the burn had collapsed to 4,830 ETH for the month. Validator tips sat at 6,606 ETH. The lines crossed. For the first time since EIP-1559 launched in August 2021, validators collected more from priority fees than the protocol destroyed in base fee burns.

December made it stark: 1,177 ETH burned, 3,950 ETH to validators. A 3.4:1 ratio in tips' favor.

The current picture is more extreme. In the past seven days:

- **ETH burned: 137 ETH** (base fee × gas used across all blocks)
- **ETH to validators: ~1,161 ETH** (priority fees from all transaction types)

That's an 8.5:1 ratio — flipped from the 4.5:1 that existed in January 2025. The inversion is 38× more pronounced than a year ago.

What's strange is that tips didn't collapse proportionally. Total user gas payments dropped roughly 16× from their January 2025 peak. The burn dropped 85×. But validator tip income only dropped about 3-4×. The gap between those two collapse rates is the story.

```sql
-- Current 7-day priority fee distribution (type 2 txs only)
SELECT
  round(max_priority_fee_per_gas/1e9, 2) as tip_bucket,
  count() as tx_count,
  round(100.0 * count() / (SELECT count() FROM canonical_execution_transaction
    WHERE meta_network_name = 'mainnet' AND transaction_type = 2
    AND updated_date_time >= now() - INTERVAL 7 DAY), 3) as pct
FROM canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND transaction_type = 2
  AND success = 1
  AND updated_date_time >= now() - INTERVAL 7 DAY
GROUP BY tip_bucket HAVING tx_count > 10000
ORDER BY tx_count DESC LIMIT 10
```

Results for the past seven days:

| Priority fee | Transactions/week | % of total |
|---|---|---|
| **0 gwei** | 4,227,682 | **35.3%** |
| 0.01 gwei | 1,693,004 | 14.1% |
| **2 gwei** | **1,026,752** | **8.6%** |
| 1 gwei | 866,778 | 7.2% |
| 0.05 gwei | 431,367 | 3.6% |

Two things here that shouldn't coexist but do.

**35% of transactions pay zero priority fee.** They're included. The minimum tip needed to get a transaction onto Ethereum right now is literally nothing — blocks are 50% full and there's always room. When demand doesn't exceed block space, even 0-tip transactions get picked up.

Yet **8.6% of transactions still send exactly 2 gwei** in priority fees. That's 1,026,752 transactions per week at a tip that's 40× the current average base fee and unnecessary for inclusion.

Where is the 2 gwei default coming from?

```sql
-- Who's sending 2 gwei tips (top recipients, 7 days)
SELECT to_address, count() as tx_count, round(avg(gas_used)) as avg_gas
FROM canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND transaction_type = 2
  AND max_priority_fee_per_gas = 2000000000
  AND updated_date_time >= now() - INTERVAL 7 DAY
GROUP BY to_address ORDER BY tx_count DESC LIMIT 5
```

| Contract | Txs/week at 2 gwei | ETH/week to validators |
|---|---|---|
| USDT (0xdac17f...) | 204,474 | ~20 ETH |
| USDC (0xa0b869...) | 116,309 | ~12 ETH |
| MetaMask swap router | 24,725 | ~12 ETH |
| Aave V3 | 5,680 | ~3 ETH |

The 2 gwei default is a wallet artifact. When Ethereum's base fee was 5-10 gwei in 2024-early 2025, a 1.5-2 gwei tip was a reasonable 15-30% premium for priority. Wallets set it as a default. Today, with base fees at 0.05 gwei, that same tip is 40× the base fee and goes entirely to the validator for nothing. The stablecoin transfers alone — USDT and USDC — are sending ~32 ETH/week to validators as pure overpayment.

Total from the exactly-2-gwei cohort: **154 ETH/week** to validators from transactions that could have paid 0 and still been included in the next block.

The 1-2 gwei tier (1.43 million transactions/week) contributes **196 ETH/week** of the ~1,095 ETH total. The "over 5 gwei" tier (75K txs, mostly MEV-sensitive arbitrage and DeFi) accounts for **681 ETH/week** — those are actually rational; they're competing for priority in congested slots.

The monetary policy angle is worth naming. EIP-1559 was designed in part to make ETH deflationary — burning base fees removes supply. When burn exceeded issuance, ETH was net deflationary. That hasn't been true since November 2025. Consensus layer issuance runs around 5,000 ETH/week. With 137 ETH/week burned, net issuance is now about 4,863 ETH/week. ETH is inflationary by roughly 0.8% annually at current prices and activity levels.

The gas limit increases bought real benefits: cheap transactions, accessible DeFi, a network that doesn't price out regular users. The cost was burning through EIP-1559's deflationary mechanism. Whether that tradeoff was the right one depends on what you think Ethereum's fee market is actually for.

The data suggests most users don't know or care. They're paying 2 gwei tips on USDT transfers because their wallet told them to in 2024, and nobody's updated the defaults.
