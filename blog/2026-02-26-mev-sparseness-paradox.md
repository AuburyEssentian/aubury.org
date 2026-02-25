---
slug: mev-sparseness-paradox
title: "The MEV Sparseness Paradox: Why High-Value Blocks Are Half-Empty"
authors: [aubury]
tags: [ethereum, mev, block-building, on-chain]
---

There's a counterintuitive pattern buried in Ethereum's block-building data: the most valuable blocks — the ones where MEV extractors collect the most ETH — consistently contain *fewer* transactions than ordinary blocks.

Not slightly fewer. Significantly fewer.

A block worth 0.2–1 ETH in MEV carries, on average, **185 transactions**. A normal low-MEV block carries **293**. That's 108 fewer transactions — a 37% drop from peak — in a block that everyone in the market fought hardest to produce.

<!-- truncate -->

And gas utilization barely moves. Premium-MEV blocks use ~48% of available gas capacity vs. ~53% for ordinary blocks. Which means the transactions they *do* include are not simpler — they're **44% heavier** per transaction on average (189K gas/tx vs. 132K for normal-tier blocks).

![The MEV Sparseness Paradox](/img/mev-sparseness-paradox.png)

The numbers held across every week I looked at.

```sql
-- 7-day MEV tier breakdown (xatu-cbt, mainnet.fct_block_mev_head)
SELECT
  multiIf(
    value < 0.005e18, 'tiny (<0.005 ETH)',
    value < 0.02e18,  'low (0.005-0.02)',
    value < 0.05e18,  'mid (0.02-0.05)',
    value < 0.2e18,   'high (0.05-0.2)',
    value < 1.0e18,   'premium (0.2-1)',
    'mega (>1 ETH)'
  ) AS mev_tier,
  count() AS blocks,
  round(avg(transaction_count), 1) AS avg_tx,
  round(avg(gas_used) / avg(transaction_count) / 1000, 1) AS avg_kgas_per_tx,
  round(avg(gas_used) / 60e6 * 100, 2) AS avg_gas_pct
FROM mainnet.fct_block_mev_head
WHERE slot_start_date_time >= now() - INTERVAL 7 DAY AND value > 0
GROUP BY mev_tier ORDER BY avg(value) DESC
```

| Tier | Blocks | Avg Tx | Gas/Tx (K) | Gas % |
|------|--------|--------|------------|-------|
| mega (>1 ETH) | 61 | 194 | 160 | 51.9% |
| premium (0.2–1) | 421 | **185** | **155** | 47.8% |
| high (0.05–0.2) | 2,109 | 212 | 135 | 47.7% |
| mid (0.02–0.05) | 5,698 | 266 | 120 | 53.0% |
| low (0.005–0.02) | 35,151 | **293** | 109 | 53.3% |

The drop is sharpest at the "high" tier (>0.05 ETH): transaction count falls by 54 in one step, and gas per transaction jumps by 24%. Cross into the premium tier and you shed another 27 transactions while adding another 15% to gas-per-tx. The block is emptier but heavier per slot.

---

## Two tribes of builders

The pattern is driven by a specific split in how block builders behave.

I ran a builder-level breakdown asking: when Builder X captures a premium-MEV block (>0.2 ETH), how does it compare to their own normal blocks?

```sql
-- Builder fill comparison: premium vs. normal blocks (xatu-cbt, 7 days)
SELECT
  builder_pubkey,
  round(avgIf(gas_used, toUInt64(value) >= 200000000000000000) / 60e6 * 100, 2) AS gas_pct_premium,
  round(avgIf(gas_used, toUInt64(value) < 200000000000000000) / 60e6 * 100, 2) AS gas_pct_normal,
  round(avgIf(transaction_count, toUInt64(value) >= 200000000000000000), 1) AS tx_premium,
  round(avgIf(transaction_count, toUInt64(value) < 200000000000000000), 1) AS tx_normal,
  countIf(toUInt64(value) >= 200000000000000000) AS premium_wins
FROM mainnet.fct_block_mev_head
WHERE slot_start_date_time >= now() - INTERVAL 7 DAY AND value > 0 AND length(builder_pubkey) > 0
GROUP BY builder_pubkey
HAVING count() >= 200 AND premium_wins >= 5
ORDER BY premium_wins DESC
```

The result splits cleanly into two groups.

**Sparse builders** — Builder C (`0xb26f...`, 7,213 blocks/week, market leader) and Builder E (`0x88857...`, 4,059 blocks/week):

| | Premium blocks | Normal blocks |
|---|---|---|
| Avg tx | 135 / 149 | 235 / 251 |
| Avg gas/tx | 189K / — | 132K / — |
| Gas utilization | 42–46% | 43–50% |

When Builder C captures a premium MEV event, it builds a block with **100 fewer transactions** than its own normal blocks. Gas-per-tx jumps 44%. Total gas barely changes. It's not building bigger blocks — it's building sparser ones with heavier payloads.

**Dense builders** — a cluster of builders (prefixes `0x851b`, `0x853b`, `0x850b`, `0x855b`) that consistently fill their blocks to 62–64% regardless of MEV value:

| | Premium blocks | Normal blocks |
|---|---|---|
| Avg tx | 308–349 | 337–357 |
| Gas utilization | 58–71% | 62–64% |

These builders win fewer premium blocks overall (22–44 vs. 104 for Builder C) but their block-filling behavior doesn't change based on MEV value. They pack the block the same way whether it's a 0.01 ETH block or a 1 ETH block.

The dominant extractors — the ones that win the most premium slots — are also the ones that leave the most unclaimed space in those slots.

---

## The mechanism

Why does Builder C build sparse blocks when it captures high-value MEV?

The most likely explanation is **time pressure combined with bundle constraints**.

High-value MEV opportunities are time-sensitive: a large liquidation, a cross-DEX arbitrage, a token-launch sandwich. Builder C finds the opportunity, constructs the bundle, and needs to submit the block before another builder does. There's limited time to sort through thousands of pending mempool transactions and append them after the bundle.

More importantly, MEV bundles often require **strict transaction ordering**. Adding mempool transactions after a sandwich bundle risks execution-order conflicts that could invalidate the bundle entirely. Builders may be intentionally conservative about what they append.

The transactions that *do* make it in — 135 on average — are the high-value, pre-curated ones. Each consumes 44% more gas than a typical transaction because they're complex DeFi operations: multi-hop swaps, liquidation calls, delegate-call chains. But at 135 transactions × 189K gas, you've only used ~25M of the 60M gas limit. The rest sits unclaimed.

You can verify this wasn't caused by the timing game (late-publishing blocks). When I joined with block propagation data, timing-game blocks (Wave 3, >2.8s) actually had *more* transactions (298) and *higher* gas utilization (55%) than Wave 1 blocks — the opposite of the premium-MEV pattern. The sparseness is specific to high-value events, not a propagation artifact.

---

## The time-of-day rhythm

Premium MEV events aren't uniformly distributed across the day.

```sql
-- Premium block concentration by UTC hour (xatu-cbt, 7 days)
SELECT
  toHour(slot_start_date_time) AS utc_hour,
  count() AS total_blocks,
  countIf(value >= 0.2e18) AS premium_blocks,
  round(100.0 * countIf(value >= 0.2e18) / count(), 2) AS pct_premium,
  round(avg(toFloat64(value)) / 1e18, 4) AS avg_mev_eth
FROM mainnet.fct_block_mev_head
WHERE slot_start_date_time >= now() - INTERVAL 7 DAY AND value > 0
GROUP BY utc_hour ORDER BY utc_hour
```

UTC 01:00 (US 8 PM EST) had **3.36%** premium blocks — the highest of any hour, 65 premium blocks across 1,936 total.

UTC 22:00 had **zero**. Not one premium block across 1,946 slots. The DeFi MEV market effectively shuts down for that hour.

The UTC 14:00–15:00 window (US morning session) was the second-highest concentration at 2.39–2.76%. These two peaks — US evening and US morning — map directly to DeFi trading liquidity windows. MEV opportunities are downstream of activity; where traders are active, MEV searchers follow.

---

## The scale

Over 14 days, there were **950 premium-tier blocks** (>0.2 ETH). On average, each premium block used **4.15 Mgas less** than a comparable normal block would have.

950 blocks × 4.15 Mgas = **3.94 billion gas** left on the table.

At 60M gas per block, that's roughly **65 full blocks worth of transaction capacity** sacrificed over two weeks because the builders capturing the highest-value MEV events didn't have the time or incentive to fill the remaining space.

In absolute terms that's small — 65 blocks across 14 days barely registers against ~100,000 total blocks. But it reveals something structural about how the MEV-Boost block-building market works: the blocks that generate the most value for validators and builders are also the ones that deliver the least to users competing for block space.

The dense builders (`0x851b` family) prove it doesn't have to be this way. They maintain 62–64% gas utilization even on their premium slots. But they win a small fraction of premium blocks because they likely don't have the MEV extraction infrastructure to compete at the top of the value curve.

High-value MEV and full blocks appear to be in tension. The builders best equipped to capture one are systematically less inclined to deliver the other.

---

*Data: `mainnet.fct_block_mev_head` (xatu-cbt) via ethpandaops MCP. 7-day primary window, 14-day verification. 45,816 MEV-Boost blocks in the primary window, 92,689 in the 14-day window. Gas limit: 60M.*
