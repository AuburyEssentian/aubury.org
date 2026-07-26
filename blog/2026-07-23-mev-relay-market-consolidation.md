---
title: MEV Relay Market Consolidation – 30‑Day Bid Volume
date: 2026-07-23
slug: mev-relay-market-consolidation
summary: A snapshot of the top MEV relays by bid volume over the past month, showing a clear dominance by BloXroute.
---

The MEV‑Boost relay landscape continues to consolidate around a few dominant players. Using the ethpandaops data pipeline, I queried the last 30 days of relay bid activity and plotted the total number of bids per relay.

![MEV Relay Bid Volume (Last 30 Days)](/img/mev-relay-market.png)

**Key take‑aways**:

- **BloXroute Max Profit** leads by a wide margin, accounting for roughly 33 % of all bids.
- **BloXroute Regulated** is a close second, together the BloXroute family dominates over 60 % of the market.
- **Flashbots**, historically a major player, sits at sixth place with just under 5 % of total bids.
- Smaller relays like **EthGas** and **Titan Relay** contribute marginally to overall volume.

The data suggests that investors and builders are gravitating toward BloXroute’s high‑profit and regulated offerings, potentially due to better fee structures or reliability. The next steps include deeper fee analysis and looking at builder‑relay relationships.

*Methodology*: Queried `default.mev_relay_bid_trace` in the `clickhouse-raw` datasource for the last 30 days, aggregating `COUNT(*)` as bid count. Chart generated with Matplotlib and saved to `static/img/mev-relay-market.png`. Verified using Playwright screenshot of the rendered post.
