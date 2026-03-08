---
title: "ETH is inflationary now, and the burn rate won't save it"
description: "With base fees at 0.05 gwei and blob fees near zero, Ethereum burns roughly 20 ETH per day against ~1700 ETH in validator issuance. Net supply growth: +1680 ETH/day. A look at 127 days of on-chain burn data."
slug: eth-burn-post-fulu
authors: aubury
tags: [ethereum, issuance, monetary-policy, fulu, eip-1559]
hide_table_of_contents: false
---

When Ethereum transitioned to proof-of-stake in 2022, the combination of EIP-1559 burning and reduced issuance made the supply actually deflationary during periods of high activity. You'd see charts showing ETH supply shrinking, treasury posts celebrating "ultrasound money," and a widespread assumption that high network usage would keep issuance in check.

That assumption is dead. The data from the last four months makes it clear.

<!-- truncate -->

![ETH burn vs validator issuance since November 2025](/img/eth-burn-post-fulu.png)

The numbers above are from `canonical_execution_block` in the EthPandaOps xatu dataset. The query is simple: `sum(base_fee_per_gas * gas_used) / 1e18` per day, 127 days running from November 2025 through March 7, 2026.

Here's what it shows:

**Daily ETH burned (base fee destruction):**
- November 2025 average: 77.5 ETH/day (already low — but included a bull run)
- Post-Fulu (Dec 3) median: 18.5 ETH/day
- 2026 YTD median: 19.9 ETH/day

**Validator issuance:**
- Approximately 1,700 ETH/day at the current ~958,000 active validators

**Net:** Ethereum is issuing roughly 1,680 ETH per day more than it burns. Annualized, that's about 613,000 ETH of new supply per year, or around 0.5% of total supply.

The burn has never come close to matching issuance in this entire 127-day window. Not once. The highest single-day burn was February 5, 2026 at 588 ETH, driven by a major MEV arbitrage storm — and even that barely dented the gap.

---

## What happened on December 3

Fulu activated on December 3, 2025. The main feature was PeerDAS, but Fulu also coincided with a fundamental shift in base fee dynamics. Base fees had already been falling for months as the gas limit increased (30M → 60M through 2025) and the EIP-1559 target price equilibrium adjusted downward. By the time Fulu activated, base fees were around 0.05 gwei — down from 10+ gwei in early 2025.

The gas limit doubling is the real driver. EIP-1559 targets 50% block utilization. When you double the block size, the base fee needs to drop substantially to find a new equilibrium where half the new, larger capacity is filled. The network found that equilibrium around 0.04–0.07 gwei, and it's been stable there ever since.

The pre-Fulu period in November still had occasional spikes — November 3-6 was a bull market activity surge that briefly pushed daily burn to 176–435 ETH. But even those spikes didn't approach issuance levels.

After Fulu, those spikes got smaller and the baseline got lower. The median settled at about 18 ETH/day.

---

## MEV events are the only exception

Looking at the data, the only days where burn significantly exceeded its recent baseline were driven by extreme MEV activity:

- **January 31, 2026**: 338 ETH burned. This corresponds to the massive MEV storm documented separately — 1,193 ETH in proposer rewards in a single day.
- **February 5, 2026**: 588 ETH burned. Another MEV cascade event, the highest single-day burn in the entire 127-day window.
- **February 6, 2026**: 264 ETH burned (MEV storm carryover).

Even at 588 ETH, the burn was still less than 35% of daily issuance. The spikes are real, but they're noise on top of a structural baseline.

Blob fees contribute essentially nothing. EIP-4844 introduced a separate fee market for blob data, but blob base fees are near zero because actual demand hasn't come close to saturating capacity since the Fulu blob cap expansion.

---

## The monetary policy question

The original framing around "ultrasound money" assumed that a busy Ethereum would burn more than it issued. That math worked in 2022-2024 when base fees regularly hit 10-100 gwei and a busy day would destroy 2,000-8,000 ETH. The narrative was coherent.

The gas limit doubling broke it. You can't double capacity without cutting the price — that's what EIP-1559 is designed to do. The same number of transactions hitting twice the block space means half the utilization pressure, which means half the base fee, which means roughly a quarter the burn. In practice it's much worse than that because utilization adjusted back toward 50%, which pushed the equilibrium base fee way down.

The result is an Ethereum that's genuinely useful and cheap to use, but also structurally inflationary at current demand levels. At 0.5% annual supply growth, it's not dramatic. But it's real, and it's not going to self-correct unless transaction demand grows proportionally to the expanded block capacity — which hasn't happened yet.

Whether that matters depends on what you think ETH is for. If you're holding it as a yield-bearing staking asset, the ~4% staking APY still swamps the 0.5% dilution. If you're holding it as a deflationary store of value, the last four months have been a rude awakening.

The ultrasound money thesis was always conditional on network usage. Right now, usage isn't keeping up.

---

**Methodology note:** Daily burn calculated from `canonical_execution_block` (EthPandaOps xatu): `sum(base_fee_per_gas * gas_used) / 1e18` grouped by day. Validator issuance estimated at ~1,700 ETH/day based on ~958K active validators. Blob fees excluded (negligible at current rates). Data covers November 1, 2025 – March 7, 2026.
