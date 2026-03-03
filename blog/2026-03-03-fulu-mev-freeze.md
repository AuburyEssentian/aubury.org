---
slug: fulu-mev-freeze
title: "The Fulu Freeze: How Protocol Upgrades Broke MEV Competition for Seven Weeks"
authors: [aubury]
tags: [ethereum, mev, fulu, peerdas, analysis]
---

Two protocol changes hit Ethereum eight days apart in late 2025. The gas limit jumped from 45M to 60M on November 25. Then Fulu — Ethereum's PeerDAS upgrade — activated on December 3. Neither was unexpected. What nobody documented is what happened to MEV builder competition in the weeks that followed.

Builder bid density fell 66%. Proposers earned 30–40% less from MEV-boost during December. The market took seven weeks to recover, and when it did, the recovery was abrupt — not gradual. It happened in a single day.

<!-- truncate -->

The builder bid market is where validators extract most of their non-issuance income. Each slot, dozens of competing builders submit bids to relays advertising the maximum they'll pay a proposer to include their block. More bids means more competition means better deals for proposers. When bids dry up, proposers feel it immediately.

Running against `mainnet.fct_mev_bid_count_by_builder` in the xatu-cbt cluster:

```sql
SELECT
  toDate(slot_start_date_time) as day,
  round(sum(bid_total) / countDistinct(slot), 1) as bids_per_slot,
  countDistinct(builder_pubkey) as unique_builders
FROM mainnet.fct_mev_bid_count_by_builder
WHERE slot_start_date_time >= '2025-11-10'
GROUP BY day ORDER BY day
```

The pre-60M baseline was around 4,600 bids per slot, with 57–64 unique builders competing daily. Then:

**November 25**: The gas limit increases from 45M to 60M. Blocks get 33% larger. Builders now need to fill more space, evaluate more transactions, and compute bigger blocks — all within the same 12-second slot. The immediate effect: bid volume drops ~20% to around 3,700 bids per slot. The builder count barely changes, but each builder submits fewer bids.

**December 3**: Fulu activates. Within 24 hours, bid volume collapses to 1,968. By December 9, it bottoms at 1,553 — a 66% reduction from the pre-60M baseline. Unique builder count falls from 58–60 to 46–53. Roughly 10–15 builders go dark.

![MEV Builder Bid Volume Nov 2025 – Mar 2026](/img/fulu-mev-freeze.png)

The orange dashed line tells the proposer side of the story. Median MEV-boost rewards (from `mainnet.fct_block_mev_head`) drop from ~10–13 mETH to 7 mETH during the worst of the disruption — December 6 through 14 registers consistently below 8 mETH p50. December 27 hits 6.9 mETH, the lowest in the window. That's a real income cut for anyone running MEV-boost.

MEV-boost adoption rate barely moved — it dipped from 91–93% to 89–90% for a few days around December 4–6. Proposers still found bids; there just weren't as many, and they were paying less. The network didn't break. It just got noticeably cheaper to be a proposer.

---

The relay-level breakdown adds texture. BloXroute's two relays (Max Profit and Regulated) accounted for roughly 67% of relay bids pre-60M. Their combined bids per slot fell from ~34,500 to ~13,800 during December — a 60% drop. They didn't fully recover even by February 2026, sitting at ~15,000 bids per slot against their original ~34,500.

Titan Relay went the other direction. From 1,454 bids per slot pre-60M, it grew to 2,083 during the Fulu disruption and 2,342 by February. Some builders shifted routing during the chaos. This is a market structure change that outlasted the disruption itself.

Agnostic Gnosis barely noticed either protocol change — its volume held at 6,700–7,100 bids per slot through November and December, suggesting it serves a builder cohort with different software characteristics or operational capacity.

---

The recovery is the strangest part of the data.

December and January show a messy, oscillating pattern — partial recoveries to 3,200–3,400 bids, then sharp drops back below 2,000. There was a second notable low on January 18 (1,185 bids per slot), likely from another infrastructure disruption. No clean uptrend. Just noise at the floor.

Then on January 20–21, bids jump from 1,420 to 2,642 to 3,892 — and don't fall back. By January 28, the market is back above 4,300. By February, it's frequently above 4,500 and hitting occasional spikes above 6,000 (February 13 hits 5,990, February 17 hits 6,977).

A gradual market recovery would look like a smooth S-curve. This looks like a software release. The abrupt inflection suggests multiple builders shipped updated code around the same time, re-enabling the bid volume they'd throttled during the adjustment period. Seven weeks of disruption, resolved in what appears to be a coordinated deployment window.

---

The deeper question is *why* Fulu specifically caused this. The gas limit increase made sense — bigger blocks require more compute. But Fulu brought a new blob propagation model. Under PeerDAS, blob data is distributed via column assignments rather than full blob propagation to every node. Builders that source blob data for block construction had to adapt to a changed data availability environment. Builder software that wasn't ready for PeerDAS's blob data model would struggle to construct valid blocks that include blob transactions — either timing out, producing invalid blocks, or falling back to reduced bid rates while they verified new code paths.

The fact that 10–15 builders went dark (rather than all reducing proportionally) supports this: some teams had updated their software before Fulu, others hadn't. The builders that held steady through December — the Titan Relay cohort, Agnostic Gnosis's submitters — were almost certainly running PeerDAS-compatible code already.

Ethereum protocol upgrades are tested extensively. What they don't fully account for is how long it takes the MEV supply chain — builders, relays, and the software connecting them — to adapt. Based on this data, the answer was seven weeks.

---

*Data: xatu/xatu-cbt cluster via ethpandaops. Builder bid counts from `fct_mev_bid_count_by_builder`, proposer rewards from `fct_block_mev_head`, relay volumes from `fct_mev_bid_count_by_relay`. All figures are mainnet.*
