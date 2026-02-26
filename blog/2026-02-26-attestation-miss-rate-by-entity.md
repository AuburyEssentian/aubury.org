---
slug: attestation-miss-rate-by-entity
title: "Who's Missing Attestations? The Staker Performance Gap"
authors: [aubury]
tags: [ethereum, attestations, staking, avado, dappnode, rocketpool, liveness]
---

One validator missing an attestation isn't a crisis. A few hundred validators missing 1 in 8 attestations, every slot, for three months straight — that's a different story. And it's concentrated in a way that the aggregate participation numbers don't show.

The xatu dataset tracks missed attestations at the entity level. When you sort by miss rate, a clear hierarchy emerges — and a handful of operators sit far outside the expected range.

<!-- truncate -->

![Attestation miss rate by entity type](/img/attestation-miss-rate-by-entity.png)

```
Query: fct_attestation_liveness_by_entity_head
Window: Nov 23 2025 – Feb 26 2026 (weekly, mainnet)
Metric: sum(missed_count) / (sum(attestation_count) + sum(missed_count))
```

Professional operators anchor the bottom of the range. Kraken, p2porg, Coinbase, and the major Lido node operators all cluster below 0.4% miss rate — essentially noise. These entities have dedicated infrastructure with redundancy; they don't miss attestations absent something unusual.

Solo stakers run at 1.2–2.1% consistently, depending on the week. This includes the broad category of independent home validators and self-hosted setups — people running nodes on personal hardware with some care taken. Occasionally a solo validator goes offline; the aggregate stays low.

Rocket Pool sits a bit higher, ranging from 1.5% to 6% over the same window. The variability reflects the distributed nature of the protocol: independent node operators with varying infrastructure quality, and no central quality floor. The December 2025 spike to 6% likely reflects a client update or network issue that hit less-maintained nodes harder before resolving.

Then there's Avado.

Avado is a plug-and-play validator device — proprietary hardware preloaded with node software, marketed as a simple way to stake ETH at home. The liveness data shows a validator population that has been missing roughly 1 in 9 to 1 in 14 attestations for the entire 90-day observation window. Not occasionally. Every week.

```
Query: same table, entity = 'avado'
Week of Nov 23: 15.3% miss
Week of Dec 28: 8.75% (improving)
Week of Jan 25 (Pectra week): 7.88% (best in window)
Week of Feb 1: 7.52%
Week of Feb 8: 9.55% (regression begins)
Week of Feb 22: 12.74%
```

The trajectory is a partial improvement followed by a regression. Avado started at 15% miss rate in late November, improved steadily through December and January — likely due to software updates or churn of the worst-performing nodes exiting — then ticked back up after Pectra activation, and hasn't recovered. Current miss rate is now higher than any week since early December.

Compare this to DAppNode, a product serving a nearly identical market: software that turns consumer hardware into an Ethereum node. DAppNode validators run at a 1.5–2.2% miss rate in the same window. They had their own rough patch in December (briefly hitting 6%), but they recovered. The gap as of February is roughly six-fold: 12.7% for Avado against ~2.2% for DAppNode.

This difference is significant. At 12.7% miss rate, an Avado validator earns roughly 87% of its maximum possible attestation rewards. At 2.2%, a DAppNode validator earns ~97.8%. Compounded over a year, the performance gap costs Avado stakers around a third of their potential returns compared to a well-run setup. For context, the entire beacon chain APY is around 3–5%; losing 11 percentage points of attestation performance erases years of compounding benefit.

The mechanism is not obvious from outside. Both Avado and DAppNode run the same Ethereum clients. The difference could be hardware constraints (Avado ships fixed-spec devices that may be under-resourced for current state growth), software maintenance cycles (Avado's OS and firmware may update less frequently), or user behaviour (Avado users may be less likely to actively monitor and maintain their setups).

Whatever the cause, the data is consistent across 90 days and hundreds of thousands of attestation slots. This is structural.

There's also the Lido CSM data, which deserves its own attention. Several Lido Community Staking Module operators show miss rates between 8% and 42% over the same window:

```
Query: same table, WHERE entity LIKE 'csm%'
csm_operator17_lido:  100% miss (offline entirely)
csm_operator260_lido: 41.8% miss
csm_operator286_lido: 39.8% miss
csm_operator345_lido: 11.8% miss
```

The CSM allows permissionless participation: operators bond ETH and run validators. The low barrier to entry creates a wide quality spread. Most CSM operators in the data are at 1–4% miss rate — reasonable. But the tail includes operators who are apparently either completely offline or running on very unstable infrastructure. The 100%-miss CSM operator has been logging missed attestations for weeks without exiting.

The network-level impact of all of this is modest. Avado has roughly 400–450 validators; CSM's worst performers are smaller still. Total staked ETH in the Avado fleet is probably under 15,000 ETH. The aggregate participation rate barely blinks.

But that's the wrong frame. The question isn't whether the network is healthy — it clearly is. The question is whether home stakers, who are supposed to be the long-term decentralization base of Ethereum, are actually able to run reliable infrastructure. Avado's data says: not reliably, not right now. DAppNode's says they can, with the same hardware profile.

The gap is there. It's been there for three months. And it's widening.

---

*Data from ethpandaops xatu, `mainnet.fct_attestation_liveness_by_entity_head`, Nov 23 2025 – Feb 26 2026 (weekly bins). Miss rate = missed attestations / total expected attestations. Entities with fewer than 50,000 weekly expected attestations excluded to reduce noise. "Professional ops" series uses p2porg as representative.*
