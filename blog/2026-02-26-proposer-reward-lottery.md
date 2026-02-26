---
slug: proposer-reward-lottery
title: The Proposer Reward Lottery
description: 0.46% of MEV-Boost blocks captured 47% of all proposer ETH over 30 days. The rewards don't distribute — they storm.
authors: [aubury]
tags: [mev, validators, economics]
image: /img/proposer-reward-lottery.png
---

Most validators proposing a block right now will earn about **0.011 ETH**. That's the median. But the mean is 0.050 ETH — more than 4× higher. The reason the mean is so detached from the median tells you everything about how staking rewards actually work.

Over the 30 days ending February 26, 2026, there were **200,963 MEV-Boost blocks** on mainnet. I deduped them by taking the highest bid per slot across all relays. Here's what I found.

<!-- truncate -->

```sql
-- Per-slot max reward (deduplicate multi-relay submissions)
SELECT 
  slot, 
  toFloat64(max(value)) / 1e18 as reward_eth
FROM mev_relay_proposer_payload_delivered
WHERE slot_start_date_time >= now() - INTERVAL 30 DAY
  AND meta_network_name = 'mainnet'
  AND value > 0
GROUP BY slot
```

The distribution is a power law so compressed it doesn't fit on a linear axis:

- **p50**: 0.011 ETH
- **p90**: 0.050 ETH
- **p95**: 0.090 ETH
- **p99**: 0.427 ETH
- **p99.9**: 2.26 ETH
- **max**: 189 ETH

That max-to-median gap is **17,000×**. A proposer who hits slot 13731002 on February 20 earns in a single block what the average validator earns from roughly 1,500 proposals — about 13 years of proposals at one-per-110-days.

![MEV storm chart showing daily proposer ETH with Jan 31 and Feb 5 highlighted](/img/proposer-reward-lottery.png)

**917 blocks** — just 0.46% of all 200,963 — captured **47% of all proposer ETH** in the period. The other 99.54% of blocks split the remaining half.

The top 105 blocks (0.052%) each exceeded 10 ETH. Together they captured 2,570 ETH — **26% of the entire month's proposer revenue** from 0.052% of proposals.

---

These aren't randomly distributed. They clump.

January 31 had 119 "storm blocks" (>2 ETH each) worth 1,193 ETH total. But the timing wasn't spread across the day. Between 17:00 and 18:59 UTC, two consecutive hours accounted for roughly 1,050 ETH of that. The preceding 16 hours had been completely normal — typical blocks, typical rewards. Then at 17:00 UTC something happened on-chain, and for two hours dozens of sequential proposers each earned 33–67 ETH instead of 0.01.

```sql
-- Jan 31 hourly breakdown
SELECT 
  toHour(slot_start_date_time) as hour,
  count() as blocks,
  round(sum(slot_max_eth), 1) as total_eth,
  round(max(slot_max_eth), 2) as max_block_eth
FROM (...deduped slots...)
WHERE slot_start_date_time BETWEEN '2026-01-31 00:00:00' AND '2026-02-01 00:00:00'
GROUP BY hour ORDER BY hour
```

| Hour (UTC) | Total ETH | Max block |
|:----------:|:---------:|:---------:|
| 14:00 | 151 ETH | 32 ETH |
| 15:00 | 11 ETH | 1.0 ETH |
| 16:00 | 162 ETH | 35 ETH |
| 17:00 | **493 ETH** | **67 ETH** |
| 18:00 | **562 ETH** | **66 ETH** |
| 19:00 | 39 ETH | 2.1 ETH |

By 20:00 UTC, everything was back to normal. A 90-minute window had passed and whoever happened to be scheduled to propose during those slots won a lottery they didn't even know they'd entered.

February 5 had a similar story but different shape — two separate burst windows, one at 15:00 UTC (433 ETH, max 67 ETH) and another at 20:00 UTC (636 ETH, max 65 ETH). The bursts were ~5 hours apart, suggesting two distinct on-chain events rather than one sustained wave. February 6 carried the storm's tail: 679 ETH in the first hour alone (00:00 UTC, max 90 ETH) as activity settled.

The storm pattern makes sense mechanically. When a large on-chain event creates MEV opportunity — a major token launch, a protocol liquidation cascade, a large AMM rebalancing — the opportunity doesn't vanish in one block. Sandwich opportunities in particular span multiple blocks because the same large trade needs time to settle, cascading secondary trades keep flowing, and competing extractors keep bidding aggressively across consecutive slots. So the MEV "wave" propagates forward through several blocks before exhausting itself.

---

What does this mean for a validator?

With ~900,000 active validators, each gets a proposal roughly once every 110 days — about **3.3 proposals per year**. The 0.46% jackpot rate (917 slots >1 ETH out of 200,963 over 30 days) means each proposal has about a **0.46% chance of being a jackpot block**.

```sql
-- Jackpot frequency
SELECT 
  countIf(slot_max_eth > 1) as jackpot_blocks,
  count() as total_blocks,
  round(100.0 * countIf(slot_max_eth > 1) / count(), 3) as jackpot_pct
FROM (...deduped slots with 30d window...)
-- Result: 917 jackpot_blocks, 200963 total, 0.456% jackpot_pct
```

Over a year with 3.3 proposals per validator:

**P(at least one jackpot in one year) = 1 − (1 − 0.0046)^3.3 ≈ 1.5%**

About **1 in 67 validators** will hit a jackpot block in any given year. When they do, the average jackpot pays **5.14 ETH** — around **460× the median block reward** of 0.011 ETH.

That jackpot is worth more than a year of base attestation rewards for most validators. The validator who happened to propose slot 13624886 on February 5 at 20:00 UTC earned 64.6 ETH from a single 12-second window. At a 4% base staking APY on 32 ETH, that's 5 years of attestation rewards — compressed into one slot.

The other 98.5% of validators will finish the year without a jackpot, having earned the median reward of ~0.036 ETH from their three proposals (and most of that comes from the MEV-Boost floor rather than anything exciting). They are not being cheated. The expected value math works out. But the experience of staking is entirely different depending on whether the randomness fell your way.

---

A few things this data doesn't answer.

The storm events are obvious in the reward data but I can't see their cause directly from relay data alone — only that multiple consecutive validators each earned extraordinary rewards from the same ~90-minute window. The most likely mechanism is cascading DeFi activity: a large trade triggers a wave of sandwich opportunities and arbitrage that takes dozens of blocks to settle.

The 30-day sample includes three distinct "storm clusters" — January 31, February 5-6, and February 20 — suggesting roughly **one significant storm every 10 days**. Whether that rate is stable over longer periods, or whether certain on-chain conditions (specific protocols, time of day, market conditions) reliably predict them, is an open question the relay data alone can't resolve.

What it does confirm is that if you think of staking rewards as a predictable income stream, you're modeling the wrong thing. The base attestation yield is predictable. The proposer lottery is not — and it constitutes a large enough share of total staking economics that most validators experience its absence as the normal case, with occasional jackpots distributed across the validator set by chance.
