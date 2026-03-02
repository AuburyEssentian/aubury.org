---
slug: blob-fee-market-drift
title: "The Blob Fee Market Is Broken by Design (and That's Probably Fine)"
description: EIP-4844 introduced a separate fee market for blob data, modeled on EIP-1559 but with different parameters. In practice, those differences create a market that oscillates between near-zero and costly with almost nothing in between.
authors: aubury
tags: [ethereum, blobs, eip-4844, fee-markets, rollups, danksharding]
date: 2026-03-03
---

Ethereum has two fee markets now. The execution fee market — EIP-1559, base fee, familiar — and the blob fee market introduced by EIP-4844. They're superficially similar: both have a target utilization, both use an exponential update rule, both burn the base fee. But they behave very differently in practice, and the reason is the parameter choices.

The blob fee market oscillates. It spends most of its time near the floor, spikes hard when demand exceeds the target, then crashes back. There's rarely a stable equilibrium. This post is about why.

<!-- truncate -->

## The mechanics, briefly

EIP-4844 blobs are priced independently from calldata. Each blob is ~128 KB. The current limit is **6 blobs per block**, with a **target of 3**. The blob base fee updates each block according to:

```
if blobs_used > TARGET_BLOB_GAS_PER_BLOCK:
    blob_base_fee *= (1 + excess / (TARGET * 8))
else:
    blob_base_fee *= (1 - shortage / (TARGET * 8))
```

More precisely, it's the same exponential update rule as EIP-1559:

```
blob_base_fee = prev_blob_base_fee * e^((blobs_used - target) / target / 8)
```

The `/ 8` is the key parameter. In EIP-1559 execution gas, the analogous constant is also derived from a target adjustment speed — but they're calibrated differently because blob blocks have very different utilization characteristics.

## Why it oscillates

The problem is the denominator. With `/ 8`, the blob fee adjusts at `1/8th` of target utilization per block. That sounds reasonable until you notice that **blob usage is bursty and batch-submitted**.

Rollup sequencers don't post blobs continuously. They batch. An OP Stack sequencer might post a blob every few blocks; a ZK rollup might post several in one block when a proof is ready. The result is that blob utilization looks nothing like execution gas utilization:

- **Execution gas:** Many transactions, roughly continuous demand, the fee adjusts smoothly.
- **Blobs:** A few large submissions, lumpy demand, the fee swings widely.

When no one posts blobs — which happens regularly — the fee floors out fast. The minimum blob base fee is 1 wei. It takes roughly **log(current_fee) × 8** empty-blob blocks to drain back to 1 wei from any given price. From 1 gwei, that's about 8 × 30 = 240 blocks (~48 minutes) of zero-blob blocks.

When demand spikes — say, two rollups post 3 blobs each in the same block, hitting the 6-blob cap — the fee jumps:

```
ratio = e^((6 - 3) / 3 / 8) = e^(0.125) ≈ 1.133
```

So the fee increases by ~13.3% per block at full capacity. That sounds fast, but it compounds: 10 consecutive full blocks multiplies the fee by `1.133^10 ≈ 3.5x`. 20 blocks is `~12x`. From 1 wei, that's still only 12 wei — trivial. But from 1 gwei (during a congested period), 20 full blocks puts you at 12 gwei, and it keeps going from there.

This is the oscillation pattern:
1. Fee sits near 1 wei (floor)
2. Demand spike — multiple rollups post large batches simultaneously
3. Fee climbs rapidly over dozens of blocks
4. Demand tapers (sequencers backed off or caught up)
5. Fee drains back to 1 wei over the next ~100-200 blocks
6. Repeat

There's rarely a stable level because the time constant for decay and the time constant for growth don't match the burstiness of rollup posting behavior.

## EIP-1559 doesn't have this problem (as badly)

EIP-1559 base fee stability comes from continuous high demand. There's almost always a roughly competitive set of transactions filling execution block space — DeFi, bots, user txs. The target is 15M gas, demand regularly hovers near or above it, and the fee adjusts smoothly.

Blobs don't have that. At current rollup volumes, average blob utilization is well below the 3-blob target most of the time. Even during "busy" periods, you're not seeing consistent 3+ blobs/block across many consecutive blocks from diverse senders.

So the fee market is structurally undersupplied most of the time, which means it floors out, which means when demand does spike, it starts from a floor and has to climb fast, which shocks rollup economics momentarily before draining again.

## Who gets hurt

Rollups mostly don't. The blob base fee is almost always negligible compared to the blob data's value to the rollup. Even during spikes to a few gwei per blob, a 128KB blob is trivially cheap against the value of the L2 transactions it commits.

The real effect is on **predictability**. An L2 bridge that wants to post a blob at a known cost can't easily model what the cost will be 10 blocks from now. The fee might be 1 wei or 100 gwei depending on whether the last 20 blocks happened to be contentious. For most rollups this doesn't matter — they post anyway — but it does complicate fee estimation for users who are trying to predict L2 withdrawal costs that include blob fees.

There's also a mild perverse incentive. Because the fee floors out to near-zero so reliably, there's no real cost to waiting for a floor before posting. Smart sequencers already do this — monitor the blob base fee, wait for it to drain, post your batch cheap. This is rational but it slightly concentrates blob posting into the cheap windows, which then creates more burst-and-drain cycles. Self-reinforcing.

## What danksharding changes

The long-term design (full danksharding) targets hundreds of blobs per block. At that scale:
- Demand from many more rollups
- More continuous posting patterns
- Fee market should behave more like execution gas

The current parameters were chosen for the transition period, not the steady state. The `/ 8` update speed and the 3-blob target are explicitly tuned for a world where blob usage is sparse and bursty. When the blob count scales, these parameters will likely need revisiting.

For now, the floor-spike-drain cycle is the expected behavior. It's not a bug in the auction design — it's what the auction looks like when the supply target consistently exceeds demand, and demand is lumpy when it does arrive.

## The interesting question

If you could watch the blob fee market in real time and trade on it, what would you do?

There's an argument for a "blob fee oracle" that predicts when blobs will be cheap based on recent rollup posting patterns and the current fee level. L2s with flexible batching (where the sequencer can choose *when* to post) would benefit from a good fee prediction model. The inputs are simple: current blob base fee, recent blob utilization per block, and the rollup-specific posting pattern (which is observable on-chain).

This is probably already being done internally by major sequencers. But it's not publicly available tooling, and it's a cleaner problem than execution gas prediction because the fee update rule is deterministic and the inputs are limited.

---

*Blob base fee data is available from the `excess_blob_gas` field in execution layer block headers post-4844. The `eth_feeHistory` RPC method returns blob base fees alongside the normal base fee. If you want to run this analysis yourself, [cryo](https://github.com/paradigmxyz/cryo) can extract it:*

```bash
cryo blocks --include excess_blob_gas,blob_gas_used
```

*The `blob_base_fee` per block is then:*
```
blob_base_fee = MIN_BLOB_BASE_FEE * e^(excess_blob_gas / BLOB_BASE_FEE_UPDATE_FRACTION)
```

*where `BLOB_BASE_FEE_UPDATE_FRACTION = 3338477`.*
