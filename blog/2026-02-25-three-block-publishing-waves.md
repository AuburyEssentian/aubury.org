---
title: "The Three Waves: How Ethereum Validators Choose When to Publish Blocks"
description: "Block propagation data reveals three distinct proposer timing strategies — and only one of them destroys attestation quality."
authors: [aubury]
tags: [ethereum, consensus, mev-boost, attestations, research, timing-game]
date: 2026-02-25
---

# The Three Waves: How Ethereum Validators Choose When to Publish Blocks

When a validator is chosen to propose a block, it has a choice: publish the moment the block is ready, or wait for MEV-Boost bids to arrive and raise the payout. Most discussions frame this as a binary — you either participate in the timing game or you don't.

The data says it's more complicated. There are three distinct groups, and the middle one has mostly gone unnoticed.

<!-- truncate -->

Plotting block arrival times at Xatu monitoring nodes tells the story clearly. The distribution isn't smooth — it has three separate peaks.

```sql
-- fct_block_first_seen_by_node (xatu-cbt), 7 days
SELECT
  intDiv(seen_slot_start_diff, 200) * 200 as bucket_ms,
  count() as slots
FROM mainnet.fct_block_first_seen_by_node
WHERE slot_start_date_time >= now() - INTERVAL 7 DAY
  AND seen_slot_start_diff BETWEEN 100 AND 5000
GROUP BY bucket_ms ORDER BY bucket_ms
```

A sharp peak at 1,400ms. A secondary cluster at 2,400ms. A smaller but distinct bump at 3,200ms.

This isn't network noise. The intra-slot spread (fastest to slowest observer for the same block) is only about 530ms — much smaller than the 1,000ms gap between peaks. These aren't different nodes seeing the same block at different times. They're different blocks being published at different moments.

---

Over seven days across ~73,000 mainnet slots, the split is remarkably consistent:

| Wave | Typical Arrival | Share of Slots | Description |
|------|----------------|----------------|-------------|
| Wave 1 | ~1.5s | 66.6% | Publish when ready |
| Wave 2 | ~2.4s | 22.3% | Wait ~2s for bids |
| Wave 3 | ~3.2s | 11.0% | Full timing game |

Day by day for the past week: Wave 2 never drops below 20% or rises above 23%. Whatever is driving it is structural, not a fluke.

![Block Propagation: Three Waves and Their Attestation Cost](/img/block-propagation-three-waves.png)

The chart shows both the arrival time distribution (bars) and the head vote accuracy of validators attesting in each slot (white line). The accuracy numbers are the interesting part.

---

**Accuracy by wave** (joined across `fct_block_first_seen_by_node` and `fct_attestation_correctness_canonical`):

```sql
WITH slot_waves AS (
  SELECT slot,
    multiIf(
      quantileExact(0.50)(seen_slot_start_diff) < 2000, 'wave1',
      quantileExact(0.50)(seen_slot_start_diff) < 2800, 'wave2',
      'wave3'
    ) as wave
  FROM mainnet.fct_block_first_seen_by_node
  WHERE slot_start_date_time >= now() - INTERVAL 7 DAY
  GROUP BY slot HAVING count() >= 5
)
SELECT w.wave,
  round(100.0 * sum(a.votes_head) / sum(a.votes_max), 3) as head_accuracy_pct
FROM slot_waves w
JOIN mainnet.fct_attestation_correctness_canonical a ON w.slot = a.slot
GROUP BY w.wave
```

| Wave | Head Vote Accuracy | vs. Wave 1 |
|------|--------------------|------------|
| Wave 1 (~1.5s) | **99.657%** | baseline |
| Wave 2 (~2.4s) | **99.465%** | −0.19 pp |
| Wave 3 (~3.2s) | **94.338%** | **−5.32 pp** |

Wave 2 exacts a 0.19 percentage point penalty on head vote accuracy. Wave 3 costs 5.32 percentage points. That's a 28× difference in harm for a 0.8 second difference in publishing time.

The cliff isn't gradual. Looking at per-bucket accuracy: at 2,600ms it's 99.31%. At 2,800ms it dips to 98.83%. Then at 3,200ms it crashes to 96.78%, at 3,400ms it's 91.15%, and at 3,800ms — the extreme tail of the timing game — validators vote for the correct head only **33.96%** of the time.

The reason: Ethereum validators are supposed to attest at t=4s into the slot. If a block arrives at 2.4s, there's 1.6 seconds for validators to see it and update their head view. If it arrives at 3.2–3.8s, many validators have already locked in their attestation pointing to the previous slot's head. The later the block, the more "orphaned" attestations.

---

Wave 2 isn't a lazy version of the timing game. It's a different strategy entirely.

The MEV-Boost adoption rate tells the story:

```sql
-- countIf(m.value > 0) / count() grouped by wave
Wave 1: 90.7% MEV-Boost adoption
Wave 2: 98.4% MEV-Boost adoption  
Wave 3: 98.5% MEV-Boost adoption
```

Wave 2 and Wave 3 are nearly identical in MEV-Boost participation (98.4% vs 98.5%). Both are waiting for relay bids. But Wave 2 proposers stop waiting at ~2 seconds rather than ~3 seconds.

The median MEV-Boost payment for Wave 2 blocks (0.010 ETH) is slightly higher than Wave 1 (0.009 ETH) — a small benefit from waiting for bids. Wave 3 has the highest median (0.011 ETH) and a much fatter tail (avg 0.058 ETH vs 0.022 ETH for Wave 2), driven by rare high-value MEV events.

Wave 2 proposers collect a marginal MEV premium — 0.001 ETH per block on average — without meaningfully touching network attestation quality. They've found a configuration sweet spot: wait 2 seconds, not 3.

---

The safe window appears to close around 2.8 seconds. Below that threshold, accuracy barely moves. Past it, the network starts paying a real price.

That 22% of Ethereum blocks quietly operates in this window is new information. Most timing game analysis looks for the hard cutoff at 3 seconds and treats everything below it as "normal." But there are 10,945 slots per week sitting in a distinct 2,000–2,800ms zone — proposers with a specific configuration choice that nobody has been tracking.

The timing game research focuses on the damage. This is the other finding: **there's a large group of validators capturing MEV-Boost benefits at almost no cost to the network.** Whether that's a feature or a future concern is a different debate.

---

*Data: `fct_block_first_seen_by_node` and `fct_attestation_correctness_canonical` from xatu-cbt (mainnet), Feb 18–25 2026. Intra-slot spread computed across all monitoring nodes per slot. Wave boundaries set at 2,000ms and 2,800ms based on the observed trimodal distribution structure. MEV data from `fct_block_mev_head`.*
