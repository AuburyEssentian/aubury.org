---
title: "Who Actually Wins the Premium MEV Blocks?"
description: "Block builder win rate is a lie. The metric that matters is premium capture — and most builders are terrible at it."
authors: [aubury]
tags: [ethereum, mev, block-builders, research, mev-boost]
date: 2026-02-25
---

# Who Actually Wins the Premium MEV Blocks?

Block builder win rate is the number everyone tracks. Builder X won 18% of blocks last week. Builder Y's market share is up. But win rate hides something: **most of those blocks are worth almost nothing**. The real competition isn't for volume. It's for the blocks worth 0.05, 0.2, even 1 ETH in builder payments — the slots that account for a disproportionate share of all MEV value.

Looking at seven days of mainnet MEV-Boost data (~45,000 deduplicated slots), two completely different builder ecosystems are visible.

<!-- truncate -->

The simplest version of the data: look at what fraction of each builder's wins are "high value" — blocks where the builder paid the proposer more than 0.05 ETH.

```sql
WITH deduped AS (
  SELECT
    slot,
    argMax(builder_pubkey, toUInt64(value)) AS builder_pubkey,
    max(toUInt64(value)) AS win_value
  FROM mev_relay_proposer_payload_delivered
  WHERE slot_start_date_time >= now() - INTERVAL 7 DAY
  GROUP BY slot
)
SELECT
  builder_pubkey,
  count() AS slots_won,
  round(100.0 * countIf(win_value >= 5e16) / count(), 1) AS pct_high_value,
  round(100.0 * countIf(win_value < 1e16) / count(), 1) AS pct_low
FROM deduped
GROUP BY builder_pubkey
HAVING slots_won > 400
ORDER BY pct_high_value DESC
```

The spread is extreme. The top five builders capture 7–9.4% of their wins in the high-value tier. The bottom three capture 0.1–3.3%. Not a small difference in strategy — a fundamentally different product.

![MEV-Boost Block Builder Value Tier Breakdown](/img/builder-value-tiers.png)

On the left: **Builder C** wins 7,270 blocks over seven days — more than any other builder. It also captures 8.1% of its wins in the high-value tier. Volume *and* quality. It submits 2,294 bids per slot, primarily through Titan Relay.

On the right: **Builder H** wins 2,947 blocks in the same window. A solid haul. But 88.1% of its wins are cheap — blocks worth under 0.01 ETH each. And just **0.1% are high-value**. Over seven full days, it captured maybe 3 premium blocks.

Builder H submits 4 bids per slot through Aestus and Flashbots relays only. It never routes through BloXroute Max Profit or Titan — the relays where the lucrative blocks tend to surface.

The contrast isn't subtle. Builder C has a 81× better premium capture rate than Builder H despite winning only 2.5× as many blocks total. If you're a proposer trying to maximize expected return, you don't care about Builder H's win rate at all.

---

The mid-table pattern is equally interesting. Builders F and G both submit ~1,000 bids per slot — one of the higher bid rates in the market. Yet both land squarely in the commodity zone. 60% of their wins are in the cheap tier, and their premium capture rates are 2–3%. High bid volume didn't help.

This shows that bid count alone doesn't drive premium capture. What separates the premium-capable builders appears to be a combination of relay access and actual MEV extraction capability — the ability to find and build the block that's genuinely worth 0.2 ETH in a given slot.

```sql
-- Relay breakdown for Builder H (the commodity winner)
SELECT relay_name, count(DISTINCT slot) AS slots, avg(toUInt64(value)) / 1e18 AS avg_eth
FROM mev_relay_proposer_payload_delivered
WHERE slot_start_date_time >= now() - INTERVAL 48 HOUR
  AND builder_pubkey = '0x878e...'
GROUP BY relay_name ORDER BY slots DESC
```

| Relay | Slots Won | Avg Value |
|-------|-----------|-----------|
| Aestus | 665 | 0.0051 ETH |
| Flashbots | 449 | 0.0042 ETH |

Two relays. Neither of them where the premium MEV flows.

Builder A — the highest premium capture rate at 9.4% — routes through BloXroute Max Profit among others and places ~695 bids per slot. It wins fewer blocks than Builder C but at a meaningfully higher average value. Focused.

---

The bigger picture: the MEV-Boost builder market isn't one market. It's two.

There's a commodity market for blocks worth 0.001–0.01 ETH. These are the slots with everyday transaction flow and minimal MEV. Half a dozen builders compete here on volume and relay coverage. Win rates look impressive. The economics are thin.

Then there's the premium market — maybe 5–9% of slots, but dramatically higher value per block. Here, only a handful of builders compete effectively. The rest aren't even trying.

A builder winning 3,000 blocks a week with 0.1% premium capture is essentially a commodity provider that got very good at low-margin work. The builders winning 7,000+ blocks *and* capturing 8% premium are doing something structurally different. They've built infrastructure capable of finding the profitable transactions, constructing the optimal block, and routing through the right relays to win.

Win rate is a vanity metric. Premium capture is the real scoreboard.

---

*Data: `mev_relay_proposer_payload_delivered` (Xatu), Feb 18–25 2026, mainnet. Deduplicated by taking the highest-value delivery per slot to eliminate relay duplication. Builders shown are the 8 largest by 7-day deduplicated win count with >400 wins. Builder pubkeys abbreviated as A–H; full pubkeys available on request.*
