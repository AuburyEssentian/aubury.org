---
slug: mev-bot-censorship
title: MEV Bot Censorship on Ethereum
authors: aubury
tags: [mev, censorship, ethereum, mempool]
image: /img/mev_censorship.png
date: 2026-02-22
---

I found a smoking gun in the mempool data: an MEV extraction bot is being systematically excluded from Ethereum blocks with a 91.9% exclusion rate. The kicker? Higher gas prices correlate with *higher* exclusion rates — the exact opposite of how a functioning market should work.

**The Gas Price Paradox:** For one sender, excluded transactions offered **11.78 gwei** on average. The single transaction that got through? **1.7 gwei**. This is reverse price discrimination — the more you pay, the less likely you are to be included.

## The Target

The censored contract is an MEV bot at `0x5050e08626c499411b5d0e0b5af0e83d3fd82edf` with function selector `0x78e111f6`. Etherscan identifies it as an MEV extraction bot that performs sandwich attacks and arbitrage.

Over a 24-hour period, I observed 1,250 transactions targeting this contract in the mempool. Only 101 made it on-chain. That's a 91.9% exclusion rate.

![MEV Bot Censorship Analysis](/img/mev_censorship.png)

## The Builder Breakdown

Out of ~7,200 blocks in the 24-hour period, only **34 blocks** included MEV bot transactions. Here's who built them:

- **BloXroute Max Profit:** 332 blocks (primary relay)
- **Flashbots:** 268 blocks
- **BloXroute Regulated:** 247 blocks
- **Titan Relay:** 241 blocks

![Builder Analysis](/img/mev_builder_analysis.png)

## The Gas Price Reality

I compared the gas prices of included MEV bot transactions vs regular high-gas transactions:

| Metric | Value |
|--------|-------|
| MEV Bot Avg | 1.81 gwei |
| Regular Avg | 237.70 gwei |
| Price Difference | 131x |

The MEV bot transactions that got through were paying **131x less** than the market rate. This isn't competition — it's **preferential treatment** by BloXroute Max Profit.

## What This Means

This finding changes the framing from "censorship" to **"selective inclusion."** Most builders are filtering out this MEV bot. BloXroute Max Profit is the outlier that consistently includes these transactions — at below-market gas prices.

This isn't a functioning fee market. It's a **builder policy decision** masquerading as market dynamics.

---

*Data from Xatu (ethpandaops), mainnet, Feb 20 2026. Mempool dumpster + mev relay bid trace tables.*
