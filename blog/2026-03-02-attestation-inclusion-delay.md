---
title: "The Tail That Fulu Fixed — And February Broke Again"
description: "Attestation inclusion delay tells a story nobody was watching: Fulu quietly fixed the worst 5% of cases, then something in February quietly erased the gains."
slug: attestation-inclusion-delay
authors: [aubury]
tags: [ethereum, consensus, fulu, attestations, performance]
image: /img/attestation-inclusion-delay.png
---

Every attestation Ethereum's 960,000-odd validators cast has a clock on it. The slot it belongs to ticks past, and then proposers have up to 32 slots to pick it up and include it in a block. Include it in the very next slot and the attester earns a full reward. Wait two slots and the head-vote component — about three-sevenths of the total attestation reward — is already gone.

Most people assume this is a solved problem. Look at the median inclusion delay and you'd agree: it sits at roughly 1.001 slots and barely moves. The typical attestation is included almost immediately.

The median isn't the story.

<!-- truncate -->

The story is in the tail. Specifically the 95th percentile — the threshold that one-in-twenty attestations fails to beat. That number has been on a quiet rollercoaster since October, and the chart tells the whole arc in one look.

![Attestation inclusion delay, Oct 2025–Mar 2026](/img/attestation-inclusion-delay.png)

*Query: `SELECT day_start_date, avg_inclusion_delay, p95_inclusion_delay FROM mainnet.fct_attestation_inclusion_delay_daily` on the xatu-cbt ClickHouse cluster, Nov 2025–Mar 2026.*

---

In October and November 2025, the p95 was spending most of its time in the 2.0–2.25 range. That means 5% of all attestations were waiting two-plus slots before a proposer picked them up. Two slots at 12 seconds each is 24 seconds — long enough to cross the head-timely window twice over.

The gas limit increase on November 25 (45M to 60M) was supposed to be good news for everyone. More room per block, less congestion. But the inclusion delay data shows essentially no change. The p95 wobbles between 1.75 and 2.0 for the rest of November — the same range it was already hitting on low-activity days. The bigger block didn't help attestations get included faster. Attestations don't compete with EVM transactions for block space; that's a consensus-layer concern, not an execution-layer one.

Then Fulu activated on December 3.

The Fulu activation itself was rough — the p95 jumped to 2.045 on December 4, likely as clients wrestled with the new PeerDAS gossip topology. But starting December 5, something shifted. The p95 dropped to 1.818, then 1.783, then kept falling. By December 12, it bottomed at 1.686 — the lowest reading in the entire dataset. The average delay followed: from 1.22 in late November to 1.087 on December 14, the lowest since Pectra activated in May.

---

Why did PeerDAS help attestations? The honest answer is that there's no single smoking gun in this data.

The most plausible mechanism: PeerDAS reorganised the gossip layer into column subnets. Validators no longer need to receive every blob from every peer — they only custodize their assigned columns. That freed up P2P bandwidth that was previously being consumed propagating full blobs. More bandwidth available for attestation gossip means attestations reach proposers faster, and proposers include them with delay=1 rather than being forced to wait a slot.

*Cross-check: `SELECT day_start_date, avg_inclusion_delay FROM mainnet.fct_attestation_inclusion_delay_daily WHERE day_start_date BETWEEN '2025-11-25' AND '2025-12-05'` shows the improvement starting on Dec 5, not Nov 25, ruling out the gas limit as the cause.*

The January 7 blob cap increase to 21 (from 15) didn't visibly touch inclusion delay either. The p95 was already in good shape and held steady through the first three weeks of January.

---

The December-through-January window was the best the network had seen. Average delay hovering around 1.09–1.14 slots. The p95 consistently below 1.80. Rough estimate: somewhere around 7–9% of attestations were experiencing delay >= 2 (the threshold that costs validators their head reward), down from roughly 17–22% in October.

That gap is money. A validator earning ~0.07 ETH per month in attestation rewards with a 15% reduction in missed-head-reward rate sees something like a 5–6% improvement in overall attestation income. Across 960,000 validators, the aggregate improvement over the 7-week Fulu window is meaningful — hundreds of ETH per day in better attestation outcomes.

Then, over a matter of days starting January 21, the picture changed.

---

The incident window at January 21–24 is visible as a spike to 2.19 on the 24th — almost back to October levels. The hourly data shows the worst stretch was January 21 at 00:00–04:00 UTC (average 1.52–1.76, p95 reaching 3.4). Whatever happened, it hit the early-hours UTC window hardest, and the network recovered within a day.

But the p95 didn't fully recover to where it had been. January 28–31 stabilised around 1.73–1.75, a notch above the December lows. February started slightly worse, and then got progressively worse still.

By February 15, the p95 was back above 2.0. By February 20, it hit 2.11 — matching the worst days of October. The average delay was back to 1.21. The Fulu gain was gone.

*Cross-check: `SELECT avg(p95_inclusion_delay) FROM mainnet.fct_attestation_inclusion_delay_daily WHERE day_start_date BETWEEN '2025-10-15' AND '2025-11-24'` returns 2.042. The same query for Feb 15–Mar 1 returns 2.027. February has reverted to October.*

---

What changed in February? The data here doesn't offer a direct answer. A few hypotheses:

**Increased network activity.** If transaction volume and blob demand increased through February, more gossip competes for the same P2P bandwidth — the same bandwidth that Fulu freed up by switching to column sampling. That headroom doesn't last indefinitely if the network gets busier.

**Client software changes.** Consensus client releases happen continuously. A change to attestation packing logic, gossip scoring, or subnet assignment could shift inclusion patterns.

**MEV builder behavior.** Some MEV blocks are built by external parties that may prioritise transaction ordering over attestation inclusion. If MEV block frequency increased, attestation inclusion quality could degrade.

The February regression is real and measurable. The Fulu improvement wasn't a permanent structural change — it was a bandwidth-headroom story, and the headroom is narrowing.

The median is still 1.001. The tail is silently growing back.

---

*Data via ethpandaops Xatu CBT cluster (`mainnet.fct_attestation_inclusion_delay_daily`, `fct_attestation_inclusion_delay_hourly`). All times UTC. 1 slot = 12 seconds.*
