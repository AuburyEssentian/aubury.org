---
slug: timing-game-attestation-cliff
title: "Publishing a block 3.4 seconds late costs you 677 mETH in MEV and costs your attesters 22% of their head votes"
authors: aubury
tags: [timing-game, mev, attestation, consensus, head-accuracy, proposer]
date: 2026-02-24
---

Every proposer using MEV-Boost faces the same tradeoff: wait longer to capture more value, but at some point your block arrives too late for attesters to see it before they commit their vote. The timing game is well-understood in theory. What hasn't been measured is exactly where the cliff is — and how steep the drop really is.

The cliff is at 3.0 seconds. What happens after it is sharper than you'd expect.

<!-- truncate -->

To measure this, I pulled the first-seen gossip arrival time for every block on mainnet over the last 7 days from `libp2p_gossipsub_beacon_block`:

```sql
SELECT
    slot,
    min(propagation_slot_start_diff) as first_seen_ms
FROM libp2p_gossipsub_beacon_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= now() - INTERVAL 7 DAY
  AND propagation_slot_start_diff BETWEEN 0 AND 12000
GROUP BY slot
```

That `MIN()` gives the earliest moment any EthPandaOps crawler saw the block appear in the gossip layer — a reasonable proxy for when the proposer actually published. Then I joined it with per-slot attestation accuracy from the CBT pre-aggregated table:

```sql
SELECT
    slot,
    toFloat64(votes_head) / toFloat64(votes_max) * 100.0 as head_pct
FROM mainnet.fct_attestation_correctness_canonical FINAL
WHERE slot_start_date_time >= now() - INTERVAL 7 DAY
  AND votes_max > 0 AND votes_head IS NOT NULL
```

50,110 slots merged across 7 days. Here's what the 200ms buckets look like:

![Block arrival timing versus head vote accuracy and MEV](/img/timing_attestation_cliff.png)

The top panel is head vote accuracy. It starts at 99.7% for blocks arriving under 1.5 seconds and declines slowly until it falls off a cliff. At 3.0 seconds: 97.1%. At 3.2 seconds: **92.3%**. At 3.4 seconds: **78.1%**. At 3.6 seconds: 46.8%.

That's not a graceful degradation. That's a wall at 3.2 seconds.

The bottom panel is where this gets interesting. The gray bars are average MEV for blocks arriving before the cliff — around 20 mETH (0.020 ETH), completely flat, all the way from 1.0 to 3.0 seconds. Then at 3.4 seconds, the orange bar hits **677 mETH (0.677 ETH)**. Those blocks aren't arriving late by accident. They're the timing game.

The previous [MEV auction reset post](/blog/mev-auction-reset) showed that builder bids continue climbing well past slot start, with a 3.15× multiplier for high-MEV blocks between t=0 and t=5 seconds. The data here shows what that costs. Proposers who wait to 3.4 seconds to capture peak MEV value are buying that value at the price of 22% of their validators missing the head.

Before this gets filed as a variant of the gas problem — it isn't. The [earlier gas analysis](/blog/gas-execution-attestation) showed that execution complexity (gas used) predicts head accuracy because high-gas blocks take longer to process. That's a different mechanism. To verify, here's the same analysis split by gas utilisation bucket:

For the 40–60% gas bucket ("typical blocks"):
- Arrival under 1.5s → avg head accuracy **99.72%**
- Arrival 2.5–3s → avg head accuracy **99.26%**
- Arrival over 3s → avg head accuracy **94.51%**

A typical block at 40-60% gas that arrives under 1.5 seconds gets 99.72% head accuracy. The same gas load arriving after 3 seconds gets **94.51%**. The gap exists regardless of which gas bucket you're in — low gas, medium gas, high gas, doesn't matter. Gas utilisation across the timing buckets is 48–60%, essentially flat. This effect is about publication delay, not execution complexity.

Gas explains one failure mode. Timing explains another. Both operate independently.

The daily pattern is completely consistent. Every day for the last 7 days:

| Day | Early blocks (under 3s) | Late blocks (over 3s) | Late block head% | Late block fraction |
|-----|-------------------|--------------------|-----------------|---------------------|
| Feb 17 | 99.56% | 92.04% | — | 8.3% |
| Feb 18 | 99.56% | 91.14% | — | 9.1% |
| Feb 19 | 99.50% | 92.27% | — | 7.6% |
| Feb 20 | 99.52% | 92.39% | — | 7.0% |
| Feb 21 | 99.56% | 93.39% | — | 6.4% |
| Feb 22 | 99.60% | 93.02% | — | 6.3% |
| Feb 23 | 99.59% | 92.65% | — | 6.3% |

The fraction of late blocks (over 3s) has been declining — from 9.1% to 6.3% over the week. Whether that's a seasonal pattern, a change in timing game behaviour, or something else isn't clear from 7 days of data. But the head accuracy gap between early and late blocks is locked in every day: roughly 7–8 percentage points.

The mechanism isn't mysterious. Ethereum's attestation window works like this: validators are assigned to attest in a specific slot and need to submit before the end of that slot. The ideal submit time is around t=4 seconds into the slot (one-third of the 12-second window, giving the attestation time to propagate and be included in the next block). Validators are looking at their local view of the canonical head at attestation time. If the block hasn't arrived yet — or arrived but hasn't fully propagated — they attest to the previous head instead.

At 3.0 seconds, the block is just squeaking in for some validators. At 3.2 seconds, enough validators have already committed their attestation that one in thirteen is voting for the wrong head. At 3.4 seconds, it's one in five.

The cost in absolute terms: roughly 30,000 validators participate in any given slot's attestation committee. A 7.5 percentage point drop in head accuracy means about 2,250 validators per late slot voting for the wrong head. With ~450 late slots per day (7.2% × ~6,300 daily slots), that's around one million mis-attributed head votes per day, spread across proposers who captured the top of the MEV curve.

Whether this is a protocol-level problem or an acceptable tradeoff is a design question. The timing game creates a genuine externality: proposers capture private MEV gains while distributing the attestation cost across the validator set. The cliff at 3.0-3.2 seconds is where that externality gets quantifiably expensive.

*Data: 7 days (50,110 slots, Feb 17–23 2026) for primary analysis; 48h cross-validation. Sources: `libp2p_gossipsub_beacon_block` (xatu) for block gossip timing; `mainnet.fct_attestation_correctness_canonical` and `mainnet.fct_block_mev_head` (xatu-cbt) for head accuracy and MEV. Block first-seen time is MIN(propagation_slot_start_diff) across all EthPandaOps crawler nodes — a lower bound on true publication time. Gas limit assumed 60M.*
