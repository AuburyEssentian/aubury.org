---
slug: patience-transactions
title: "Patience Transactions: Ethereum's Hidden Two-Tier Mempool"
authors: [aubury]
tags: [ethereum, mempool, gas, eip-1559, base-fee]
date: 2026-03-01
---

Ethereum's base fee is so low right now — bouncing between 0.025 and 0.97 gwei — that something unexpected has emerged in the mempool: a class of transactions that aren't too cheap to ever be included. They're just cheap enough to wait.

At 0.027 gwei, the median time to inclusion is **2.6 hours**. At 0.030 gwei, it's **57 seconds**. Three thousandths of a gwei separate an hour of waiting from near-instant inclusion — and whether you wait depends almost entirely on what time UTC it is when you submitted.

<!-- truncate -->

The pattern becomes clear when you look at the base fee's diurnal cycle. Over two weeks of mainnet data (Feb 15 – Feb 28, 2026), the average base fee swings from **0.036 gwei at 04:00 UTC** to **0.176 gwei at 15:00 UTC** — a nearly 5× daily oscillation following global internet traffic patterns.

```sql
-- Base fee by hour of day (2-week average)
SELECT 
    toHour(slot_start_date_time) as hour_utc,
    round(avg(execution_payload_base_fee_per_gas) / 1e9, 4) as avg_base_fee_gwei,
    round(100.0 * countIf(execution_payload_base_fee_per_gas < 3e7) / count(), 2) as pct_rescue_windows
FROM canonical_beacon_block
WHERE slot_start_date_time >= '2026-02-15' AND slot_start_date_time < '2026-03-01'
  AND meta_network_name = 'mainnet'
  AND execution_payload_base_fee_per_gas > 0
GROUP BY hour_utc ORDER BY hour_utc
-- 04:00 UTC: avg 0.036 gwei, 11.28% of blocks below 0.030 gwei
-- 15:00 UTC: avg 0.176 gwei,  0.27% of blocks below 0.030 gwei
```

A "rescue window" is any block where the base fee dips below 0.030 gwei — the threshold where patience-tier transactions can actually be included. At 04:00–05:00 UTC, **11.3% of blocks** qualify. At 18:00 UTC, exactly **0.00%** do. Not rare. Zero.

That's the mechanism. A transaction with max fee 0.028 gwei submitted at 15:00 UTC will sit untouched until the early morning, when the base fee finally dips low enough to include it. Median wait: 1.9 hours. Not permanent exclusion — a 1.9-hour alarm clock set for approximately 4am UTC.

![Rescue window frequency and inclusion delay by gas price](/img/patience-transactions-rescue-window.png)

This is verifiable in the `mempool_dumpster_transaction` table, which tracks transactions from first mempool observation to on-chain inclusion. Over four days (Feb 22–25, 2026), among mainnet transactions priced in this range:

```sql
-- Inclusion delay by max gas price for included transactions
SELECT 
    round(gas_price / 1e9, 3) as gasprice_gwei,
    count() as total,
    round(quantileExact(0.5)(inclusion_delay_ms) / 1000.0, 1) as median_wait_s,
    round(max(inclusion_delay_ms) / 1000.0 / 3600.0, 1) as max_wait_hrs
FROM mempool_dumpster_transaction
WHERE timestamp >= '2026-02-22' AND timestamp < '2026-02-26'
  AND chain_id = 1
  AND gas_price BETWEEN 2.5e7 AND 6e7
  AND included_at_block_height IS NOT NULL
GROUP BY gasprice_gwei HAVING count() > 500
ORDER BY gasprice_gwei
-- 0.027 gwei: median 9,307s (2.6 hrs), max 24.6 hrs
-- 0.028 gwei: median 6,800s (1.9 hrs), max 24.6 hrs
-- 0.030 gwei: median 57s,  max 17.4 hrs
-- 0.031 gwei: median 11s,  max 21 hrs
```

The cliff between 0.030 and 0.031 gwei is sharp because of block frequency math. With 11% of blocks qualifying at 04:00 UTC and 0% at 15:00 UTC, the average across the whole day is about 2.3% of blocks that drop below 0.030 gwei. At 7,200 blocks/day, that's ~165 rescue blocks — one every 8.7 minutes. At 0.031 gwei, the rescue window is about 4–5% of blocks, one every ~5 minutes. At 0.031 gwei, median inclusion is 11 seconds because the next qualifying block usually appears within the same minute.

At 0.028 gwei, that same math gives one rescue opportunity every hour or so — which matches the 1.9-hour median almost exactly.

What are these patience-tier transactions? Over four days, **68,016 plain ETH transfers** (no calldata) set their max fee between 0.025 and 0.035 gwei, averaging a 66-minute wait. Another **17,661 ERC-20 transfers** (selector `0xa9059cbb`) went through the same patience tier with a median wait of 10 seconds — most of those were priced higher in the zone (0.032–0.034 gwei) where rescue windows are more frequent.

```sql
-- What's in the patience tier?
SELECT 
    data_4bytes,
    count() as total,
    round(avg(inclusion_delay_ms) / 1000.0, 0) as avg_wait_s
FROM mempool_dumpster_transaction
WHERE timestamp >= '2026-02-22' AND timestamp < '2026-02-26'
  AND chain_id = 1
  AND gas_price BETWEEN 2.5e7 AND 3.5e7
  AND included_at_block_height IS NOT NULL
GROUP BY data_4bytes HAVING total > 200
ORDER BY total DESC
-- NULL (plain ETH):  68,016 txs, avg 66 min wait
-- 0xa9059cbb (transfer): 17,661 txs, avg 12 min wait
```

The overall mempool mortality rate — transactions that appear in the mempool and never land on-chain — is only **2.0%** on clean days. What looks like transactions "dying" in the mempool is usually just them waiting for a rescue window that arrives in the early morning hours.

None of this was designed. EIP-1559 targets 50% block utilization and adjusts the base fee ±12.5% per block. What it didn't specify was that the aggregate equilibrium would produce a daily oscillation from 0.025 to nearly 1 gwei — and that oscillation would create natural "patient transaction" behavior for anyone willing to wait for global internet traffic to quiet down.

The practical implication: if you want fast inclusion, set your max fee at 0.035 gwei or above and you'll be included in essentially any block (8–15 second median). Set it to 0.030 gwei and you'll usually wait under a minute, but could wait up to 17 hours on a busy day. Set it to 0.027 gwei and you're submitting a patience transaction — it will be included, but probably not until after UTC midnight, when the rest of the world goes to sleep.
