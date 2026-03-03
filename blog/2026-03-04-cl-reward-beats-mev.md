---
slug: cl-reward-beats-mev
title: "The income stream nobody talks about: CL consensus rewards beat MEV for 93% of blocks"
authors: [aubury]
tags: [ethereum, mev, validators, proposers, consensus]
---

Every MEV dashboard focuses on the same number: the execution layer bid that the winning builder pays the proposer. It's tracked obsessively. Tournaments are run around it. Entire firms exist to maximise it. And for 93% of blocks proposed on mainnet right now, it's the *smaller* of the two income streams the proposer receives.

The other stream — the consensus layer's attestation inclusion reward — sits quietly in the background, never shown on dashboards, never cited in "MEV revenue" charts. It's roughly four and a half times larger than the median MEV-boost payment.

<!-- truncate -->

The data comes from `fct_prepared_block` in the ethpandaops xatu dataset, which captures the `consensusBlockValue` field that CL clients compute when building a prepared block. This is the protocol-calculated value of including all the attestations, sync committee contributions, and other CL operations for that slot. It's real proposer income, paid by the protocol, independent of anything happening on the execution side.

```sql
SELECT slot,
       quantileExact(0.5)(consensus_payload_value)/1e18  AS cl_eth,
       avg(execution_payload_value)/1e18                  AS local_el_eth
FROM mainnet.fct_prepared_block
WHERE consensus_payload_value > 1e16
GROUP BY slot
ORDER BY slot
```

Across six CL implementations reporting this field — Lighthouse, Prysm, Teku, Lodestar, Grandine, Teku-sm — the median value is nearly identical: **0.0479 ETH per slot**, every slot, regardless of what transactions are in the block or which builder won the MEV auction.

Then cross-referenced with `fct_block_mev_head` for the actual winning relay bids over the same 14 days:

```sql
SELECT p.slot, p.cl_eth, m.el_mev_eth,
       p.cl_eth / (p.cl_eth + m.el_mev_eth) AS cl_share
FROM prepared_block_median p
JOIN mev_relay_bids m ON p.slot = m.slot
```

98,487 MEV-boost blocks, Feb 17 – Mar 3, 2026.

![CL consensus rewards vs MEV-boost EL rewards, Feb–Mar 2026](/img/cl-vs-mev-reward.png)

The chart shows MEV-boost reward sorted from lowest to highest. The dashed blue line is the CL consensus reward. It barely moves — standard deviation of 0.0024 ETH across the entire dataset. The orange curve starts near zero and creeps upward, crossing the blue line at the 93rd percentile.

Breaking this down:

| Metric | Value |
|---|---|
| Median CL consensus reward | 0.0479 ETH |
| Median MEV-boost EL reward | 0.0104 ETH |
| Ratio (CL ÷ MEV at p50) | 4.6× |
| Blocks where CL > MEV | 92.7% |
| Blocks where CL > 2× MEV | 83.2% |
| CL share of total income at p50 | 82% |
| MEV value needed to match CL | 0.047 ETH (93rd percentile) |

The median proposer collects 0.0104 ETH from MEV-boost and 0.0479 ETH from the protocol — 0.058 ETH total, with the visible dashboard number being only 18% of the real story.

Only at the 95th percentile of MEV rewards does the execution layer start contributing meaningfully more than the consensus layer. The jackpots that everyone watches — the six-figure MEV blocks that occasionally happen — do eventually dominate, but they are genuinely exceptional. For every spectacular MEV block, there are thirteen blocks where the proposer quietly collected more from attestation inclusion than from any builder.

---

There's a historical angle here worth noting. Running the same query back through June 2025 (when this data first became available, just after Pectra), CL rewards have been steadily rising: from **0.0462 ETH** in early June to **0.0480 ETH** in March 2026 — a 3.9% increase over nine months. The mechanism is straightforward: as total staked ETH grows, proposer attestation inclusion rewards scale up with it. It's slow, predictable, and entirely absent from any MEV monitoring dashboard.

This has a few practical implications worth sitting with.

MEV-boost adoption is often framed as validators "leaving money on the table" if they don't use it. That's still true — the median gain from MEV-boost over a locally-built block is real (local EL builds yield around 0.001 ETH versus 0.010 ETH from relay bids). But the framing obscures that 82% of total proposer income is already baked into the protocol before a single builder bid is evaluated.

The proposer reward lottery that dominates validator discourse is a lottery over the remaining 18%. Winning it spectacularly matters less to cumulative income than the quiet consensus accumulation over thousands of slots.

There's also a consequence for anyone modelling validator economics: ignoring `consensusBlockValue` understates typical proposer income by 5×. The number that appears in MEV dashboards is the tip, not the meal.

---

*Data: ethpandaops.io xatu cluster, tables `mainnet.fct_prepared_block` and `mainnet.fct_block_mev_head`, Feb 17 – Mar 3, 2026. CL reward taken as per-slot median across ≥2 reporting CL clients. Blocks with `consensus_payload_value < 1e16` excluded as partial/test builds.*
