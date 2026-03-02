---
slug: orphan-cliff
title: "The Orphaning Cliff: Ethereum's Hidden Block Death Threshold"
authors: [aubury]
tags: [ethereum, consensus, timing-game, chain-reorgs, network-health]
date: 2026-03-02
---

Ethereum's block orphan rate should be nearly zero. It isn't — and the reasons why are more interesting than the number itself.

Over the last 30 days, **1,783 blocks were proposed on mainnet and then lost**. Not missed (nobody tried), not reverted (execution failed) — proposed, gossiped, and then quietly discarded when another block won the fork choice. That's 59 blocks per day that disappeared into the void.

Most of them arrived on time.

<!-- truncate -->

The first surprising thing in the data: when I bucketed orphaned blocks by their gossip first-seen time, **81% of February orphans arrived before 3.5 seconds** — well within the normal timing window. Block timing alone doesn't explain most orphans. They lost for other reasons: competing blocks, fork choice tiebreaks, network topology accidents. That's normal. At the 0.2% daily baseline, it's background noise.

The second thing is sharper.

```sql
-- 30-day gossip timing vs orphan status (xatu + xatu-cbt cross-query)
-- For each slot: min(propagation_slot_start_diff) from libp2p_gossipsub_beacon_block
-- Status from mainnet.fct_block_proposer_by_validator
-- Bucket: 200ms windows

bucket       | total  | orphaned | orphan_rate
3.4–3.6s     |  1,422 |       11 |  0.77%
3.6–3.8s     |    454 |       24 |  5.29%   ← 7× jump
3.8–4.0s     |    142 |       62 | 43.66%   ← cliff
4.0–4.2s     |     81 |       62 | 76.54%   ← flatlines high
4.2–5.0s     |   ~115 |    ~70   | ~65–75%
```

From 3.5 to 3.7 seconds: normal. From 3.7 to 3.8: a 7× jump to 5%. From 3.8 to 4.0 seconds: **you've crossed the cliff**. A block arriving at 3.8s has a 44% chance of being orphaned. At 4.0 seconds: 77%.

![The orphaning cliff and February fork events](/img/orphan-cliff.png)

This matters because of how the timing game actually works. From previous research, we know attestation accuracy starts degrading at 3.0 seconds and collapses at 3.2s. But those attestation losses don't translate into orphans until nearly 3.8s. That's a 700ms gap where timing game proposers are sacrificing attestation votes (their neighbors are signing the wrong head) but their block is still surviving in the canonical chain.

The "safe" timing game window is wider than attestation data implies. You can push to 3.7 seconds and lose attestation accuracy — but your block lives. Push past 3.8 seconds and you're building a block that has a coin-flip chance of being thrown away entirely, plus the attestation penalty on top.

There's a mechanical reason this cliff exists where it does. Ethereum's fork choice uses proposer boost — a 20% of committee weight advantage given to the block the attesters expect to see. At roughly t=3.7s into the slot, enough attesters have locked in their view that a late-arriving block can no longer accumulate the votes needed to overcome a competing block. The exact threshold depends on when attesters broadcast their votes, which is why the cliff isn't a hard wall but appears over a ~200ms transition at 3.7–3.8s.

---

Then there are the two events in February that nothing in this data predicts.

February 24, 04:00–09:00 UTC: the orphan rate hit **55–63% per hour**. Only 40% of expected blocks were visible to the monitoring infrastructure. The other 60% were on a parallel chain that the canonical infrastructure couldn't see.

February 26, 15:00 UTC through February 27, 03:00 UTC: twelve hours. Orphan rate peak at **78%** (22:00 UTC). At that hour, only 96 of 300 expected slots have entries — 21 canonical, 75 orphaned. The canonical chain was running on approximately 7% of its normal block throughput.

```sql
-- Hourly orphan breakdown during Feb 26–27 incident
SELECT toStartOfHour(slot_start_date_time) as hour,
  countDistinct(slot) as visible_slots,
  countIf(status='canonical') as canonical,
  countIf(status='orphaned') as orphaned,
  round(100.0*countIf(status='orphaned')/countDistinct(slot), 1) as orphan_rate
FROM mainnet.fct_block_proposer_by_validator
WHERE slot_start_date_time >= '2026-02-26 14:00:00'
  AND slot_start_date_time < '2026-02-27 05:00:00'
GROUP BY hour ORDER BY hour

-- 16:00 UTC: 100 visible slots, 36 canonical, 64 orphaned → 64% orphan rate
-- 22:00 UTC: 96 visible slots, 21 canonical, 75 orphaned → 78% orphan rate
-- Recovery: 03:00 UTC Feb 27 → back to 3%, full normal by 04:00
```

Both incidents self-healed. No emergency response, no client patch deployed during the event, no EF blog post. The network forked, ran parallel chains for hours, and then converged back to consensus on its own. Attestation inclusion delay confirmed the disruption — the Feb 26 event peaked at p95 = 5.5 slots (versus a normal 1.7–2.1) around 23:00 UTC.

What caused them? The data doesn't say. Blocks during both incidents arrived at normal timing (median first-seen ~1.7s), so this wasn't the timing game pushing blocks past the cliff. The orphan rate was spread across nearly every entity — staked.us, p2porg, ether.fi, solo stakers, Lido operators — with no single group immune. That cross-entity spread points toward a protocol-level fork rather than an operator configuration issue.

The entity breakdown during Feb 24 04:00-09:00:

```sql
-- Entity orphan rates during Feb 24 incident (04:00-09:00 UTC)
entity           | canonical | orphaned | orphan_rate
staked.us        |         2 |        5 |      71.4%
p2porg           |         2 |        4 |      66.7%
ether.fi         |        38 |       28 |      42.4%
solo_stakers     |        54 |       34 |      38.6%
coinbase (est.)  |        -- |       -- |      ~40%
-- No entity below 38% during peak hours
```

---

The bigger picture across the 30-day window:

The baseline orphan rate on Ethereum mainnet is **0.08–0.45% per day**, typically around 0.22%. That's 15–32 blocks per day lost to the normal background of fork choice competition. These blocks arrive on time. They were just unlucky.

The timing game cliff adds a separate class of orphan: deliberately delayed blocks that cross 3.8 seconds and face near-certain death. Over the 30-day window, these "suicide blocks" (>3.8s) numbered around 330, with 215–240 of them orphaned (65–73% loss rate).

And then the two incidents: 454 orphaned on Feb 24, 581 on Feb 26. Together accounting for **58% of all February orphans**. Two unreported network splits, both resolved silently, both leaving no public trace beyond what EthPandaOps' monitoring infrastructure captured.

The cliff at 3.8 seconds is interesting. The self-healing fork events are something else entirely.
