---
slug: ethereum-march2-finality-loss
title: "Ethereum Lost Finality for Three Hours on March 2"
authors: [aubury]
tags: [ethereum, network-health, consensus, incidents]
---

Something significant happened to Ethereum four days ago, and it's largely flown under the radar.

On March 2, 2026, between roughly 10:24 and 13:00 UTC, the mainnet experienced its most severe consensus disruption since the proof-of-stake transition. Block orphan rates hit 68%. Validator participation collapsed to zero in at least one epoch. The chain stopped finalizing — not for twenty minutes like the May 2023 incident, but for close to three hours.

This is the third network incident in twelve days.

<!-- truncate -->

## What the numbers say

The chart below shows hourly orphan rates across the past two weeks. Normal is under 1%.

![Ethereum mainnet orphan rate spikes Feb–Mar 2026](/img/march2-orphan-incidents.png)

*Data: xatu-cbt / ethpandaops. Each point represents the fraction of proposed blocks that were orphaned in that hour.*

February 27 saw the first anomaly — a 17% orphan spike lasting about three hours, which I covered in an earlier post. Elevated, but the chain never threatened finality (the threshold is 33%).

March 2 was a different order of magnitude.

**`[Query: fct_block_proposer_by_validator WHERE slot_start_date_time BETWEEN '2026-03-02 10:00' AND '2026-03-02 14:00']`**

```
hour                 orphaned  canonical  orphan_pct
2026-03-02 10:00        121       178        40.5%
2026-03-02 11:00        204        94        68.5%   ← peak
2026-03-02 12:00        158       142        52.7%
2026-03-02 13:00         32       266        10.7%   ← recovery
```

The worst single epoch — epoch 431313, starting at 10:43 UTC — had just 4 canonical blocks out of 32 slots. That's an 87.5% orphan rate in a single 6.4-minute window. In that epoch, slot after slot, the proposed block lost to its competing fork.

## Finality, lost

For the chain to finalize, at least two-thirds of validators (by stake weight) must attest to the same checkpoint. When participation drops below that threshold, finalization stops and the inactivity leak begins.

**`[Query: fct_attestation_participation_rate_hourly WHERE hour_start_date_time BETWEEN '2026-03-02 09:00' AND '2026-03-02 14:00']`**

```
10:00 UTC — participation: 62.2% avg, 5.3% minimum
11:00 UTC — participation: 36.8% avg, 0.0% minimum  ← finality lost
12:00 UTC — participation: 57.3% avg, 13.0% minimum
13:00 UTC — participation: 99.9% avg                ← restored
```

That 0% minimum at 11:00 UTC isn't a rounding artifact. At least one epoch during that hour had zero participation on the canonical chain — meaning every attesting validator was pointing at a different fork. The canonical chain was a ghost, producing blocks that no one was voting for.

Finality was gone from approximately 10:24 UTC until around 13:00 UTC. Roughly two and a half hours.

## Nobody was spared

One thing that stands out from the entity breakdown is how uniform the damage was. This wasn't a single-client outage.

**`[Query: fct_block_proposer_entity JOIN fct_block_proposer_by_validator WHERE slot_start_date_time BETWEEN '2026-03-02 10:00' AND '2026-03-02 13:00']`**

| Entity | Orphan rate |
|---|---|
| Everstake | 76.9% |
| OKEx | 66.7% |
| Coinbase | 60.7% |
| Solo stakers | 55.9% |
| Ether.fi | 55.1% |
| Figment | 57.9% |
| Liquid Collective | 63.6% |

Professional operators, solo validators, liquid staking protocols — all hit in the 55–77% range. When a bug affects one client heavily, the distribution clusters around client-operator pairings. Here, it doesn't.

The December 2025 Prysm bug (Fulu activation) dropped network participation by 25% — severe, but contained to Prysm validators and never breached finality. What happened on March 2 hit everyone. That difference matters for diagnosing what went wrong.

## Three incidents, escalating

Put the timeline together:

- **December 4, 2025**: Prysm bug during Fulu activation. Participation drops to ~75% for several hours. Finality maintained but close (needed just 9 percentage points more to fail). Patched rapidly.
- **February 27, 2026**: Orphan rate spikes to 17% for ~3 hours. Finality not threatened. No public post-mortem published.
- **March 2, 2026**: Orphan rate hits 68.5%. Participation reaches 0% in epochs. Chain loses finality for ~2.5 hours. No public disclosure at time of writing.

The pattern is escalation. December was a known single-client bug with a fast patch. February suggested something else was developing. March 2 looks like whatever that something is reached a breaking point.

## What we don't know

The entity-uniform nature of the orphan spike points toward a fork choice or block propagation failure rather than a client implementation bug. Two forks formed, most of the network ended up on the losing one, and the canonical chain wrote most of its blocks into history alone.

Reorg data from monitoring nodes shows the dominant reorg depth was 1–2 slots, with a handful of depth-3 events. No 644-slot reorgs as suggested by some sentinel values in the raw table. This is consistent with a network that was continuously confused about which fork to build on, rather than one giant reorganization event.

What triggered it, and why it lasted two and a half hours instead of resolving in minutes the way normal splits do — that's still an open question.

The data exists to answer it. Someone should.

---

*Queries run against xatu-cbt (ethpandaops), 14-day lookback window, mainnet only. Raw numbers checked against multiple table sources for consistency.*
