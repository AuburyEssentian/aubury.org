---
slug: epoch-transition-tax
title: The Epoch Transition Tax
description: Every 6.4 minutes, Ethereum's consensus clients slow down to process epoch state transitions. The head update latency spike — and the 6× wrong-head attestation rate that follows — is measurable, consistent, and varies dramatically by client.
authors: aubury
tags: [ethereum, consensus, attestations, epoch, clients]
date: 2026-02-28
---

Every 6.4 minutes, Ethereum's consensus clients have a problem. At the boundary between epochs, they need to do expensive work — update validator balances, compute committee assignments, tick the justification/finalization machinery. While they're doing it, the network doesn't stop. Blocks keep arriving. Attesters keep committing to what they see.

What happens to validators whose client is still mid-computation when the attestation window opens? They vote for the wrong head.

<!-- truncate -->

Here's how this looks in the data. The `beacon_api_eth_v1_events_head` table records when each monitoring node's beacon API emits a "new head" event — the moment the CL has processed the block and updated its view of the chain. Across 7 days and all five major CL clients, the pattern is consistent and striking.

```sql
SELECT 
  meta_consensus_implementation,
  if(slot % 32 = 0, 'epoch_boundary', 'mid_epoch') AS slot_type,
  round(quantileExact(0.5)(propagation_slot_start_diff), 0) AS p50_ms,
  round(100.0 * countIf(propagation_slot_start_diff > 3000) / count(), 2) AS pct_after_3s
FROM beacon_api_eth_v1_events_head
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= now() - INTERVAL 7 DAY
  AND propagation_slot_start_diff BETWEEN 0 AND 12000
GROUP BY meta_consensus_implementation, slot_type
ORDER BY meta_consensus_implementation, slot_type
```

The global block arrival p50 is 1.78 seconds from slot start — that's the network baseline.

![Epoch Transition Tax chart](/img/epoch-transition-tax.png)

The bars show head update time per CL client: blue for mid-epoch, red for epoch boundaries, with the orange extension showing p90. The yellow dashed line at 3 seconds is the rough attestation cut-off — attesters who haven't seen the latest block by then will vote for the wrong head.

**Lighthouse** takes a median 2.21 seconds to update its head in normal slots. At epoch boundaries, that becomes **3.93 seconds** — with 66% of head events arriving after the 3-second mark. **Prysm** hits 3.26 seconds at boundaries, with 60% late. **Grandine** barely moves: 1.95 seconds normally, 2.27 seconds at boundaries, and only 22% late.

The same data broken out by slot position shows the effect is surgical — it hits exactly slot 0 and nobody else:

```sql
-- Attestation head accuracy by epoch slot position
SELECT 
  slot % 32 AS epoch_position,
  round(100.0 * sum(votes_head) / sum(votes_max), 3) AS head_accuracy_pct,
  round(100.0 * sum(votes_other) / sum(votes_max), 3) AS wrong_head_pct
FROM mainnet.fct_attestation_correctness_canonical
WHERE slot_start_date_time >= now() - INTERVAL 7 DAY
GROUP BY epoch_position
ORDER BY epoch_position
```

**Slot 0: 94.28% head accuracy (5.41% wrong-head). Slots 1–31: 98.73–99.11%.** A 6× spike in wrong-head votes, at one precise moment, that returns to baseline immediately at slot 1.

The slot 1 recovery deserves attention. For Lighthouse: 3.93 seconds at slot 0, 2.23 seconds at slot 1 — an immediate snap back. The epoch transition computation completes, the client catches up, and everything normalizes. There is no cascading degradation. The damage is contained to a single slot, every 32 slots.

The why isn't mysterious. At every epoch boundary, consensus clients must compute:

- **Validator balance updates** — pending rewards, penalties, inactivity leaks applied across all ~960,000 validators
- **Committee shuffling** — new committees and proposer duties for the next 32 slots
- **Justification and finalization** — advancing the finality gadget based on recent participation
- **Sync committee selection** — periodic rotation of the 512-validator sync committee

Different clients have made different choices about *when* to do this work. Grandine appears to precompute or parallelize aggressively, absorbing most of the overhead before the slot boundary hits. Lighthouse does more of it inline during block processing, which explains both the longer median and the dramatic p99 (11.2 seconds — nearly a full slot).

That p99 number is worth sitting with. One in a hundred epoch-boundary slots, a Lighthouse node takes more than 11 seconds to update its head view after receiving the block. The slot is 12 seconds long.

The seven-day daily consistency confirms this isn't noise:

```sql
SELECT 
  toDate(slot_start_date_time) AS day,
  meta_consensus_implementation,
  round(quantileExact(0.5)(propagation_slot_start_diff), 0) AS p50_ms,
  round(100.0 * countIf(propagation_slot_start_diff > 3000) / count(), 1) AS pct_after_3s
FROM beacon_api_eth_v1_events_head
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= now() - INTERVAL 7 DAY
  AND slot % 32 = 0
  AND meta_consensus_implementation IN ('lighthouse', 'grandine', 'teku', 'nimbus')
GROUP BY day, meta_consensus_implementation
ORDER BY meta_consensus_implementation, day
```

Lighthouse ranges from 3.25–4.12 seconds p50 across 8 days, with 56–70% of head events late. Grandine stays at 2.19–2.49 seconds throughout. The spread is structural, not episodic.

A few caveats worth stating clearly. The `beacon_api_eth_v1_events_head` data comes from monitoring sentries watching specific beacon nodes — not from validators directly. Lighthouse has 147,799 monitoring nodes, Nimbus 50,202, and Teku 50,142, making their numbers very reliable. Grandine (4 nodes) and Prysm (11 nodes) have much smaller samples and should be read directionally rather than precisely.

The 6× wrong-head rate at epoch boundaries is the network aggregate — it reflects the combined effect of all client implementations, including their distributions across the real validator set. Clients with larger validator market share contribute more to that number.

Ethereum does 225 epoch transitions per day. Each one costs roughly a third of attesters their head vote accuracy for a single slot. The math: 5.41% wrong-head at epoch boundary slots, vs 0.90% at normal slots — an extra 4.5 percentage points per epoch transition. That's a recurring tax, paid precisely and predictably, every 6.4 minutes.

The network tolerates it fine. Finality still works. But if you're running validators and care about maximising rewards, you have a clear signal about which clients absorb the epoch transition overhead with the least damage.

*Data: [`beacon_api_eth_v1_events_head`](https://ethpandaops.io/data/) (7 days, mainnet) · [`fct_attestation_correctness_canonical`](https://ethpandaops.io/data/) (7 days, CBT) — ethpandaops Xatu*
