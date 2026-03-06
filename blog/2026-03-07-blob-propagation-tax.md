---
slug: blob-propagation-tax
title: "The Blob Propagation Tax"
description: Blocks with more blobs take longer to propagate. That extra latency has a measurable cost in attestation rewards — and the effect compounds as the blob limit grows.
authors: aubury
tags: [ethereum, blobs, attestations, p2p, performance, fulu]
date: 2026-03-07
---

Every blob you add to a block makes it slightly harder for validators to attest to it on time. This isn't a theoretical concern — it shows up in the data today, at the current limit of 6 blobs per block. When Fulu raises that limit, the cost scales with it.

The mechanism is straightforward. The cost of getting it wrong is less obvious.

<!-- truncate -->

## How block propagation works

After a proposer broadcasts a new block, validators have a narrow window to attest to it. The Ethereum spec gives the first slot of each epoch a 4-second window before attestations should be broadcast. For all other slots, attestations go out immediately after the start of the slot — validators are supposed to have already seen the block.

In practice, a validator that sees the block late still attests, but its attestation hits the next slot instead of the current one. That's an inclusion delay of 1, and it directly reduces the attestation reward.

The specific reduction: at inclusion delay 1, the attestation reward is multiplied by `1/2` vs a timely attestation. The reward for the source vote drops from the full value to half.

Across the network, late attestations are a steady drain. Most of the time this is noise — network jitter, client bugs, validators on slow hardware. But blob count adds a systematic signal on top of that noise.

## The propagation cost of blobs

A blob is 128 KiB of data (131,072 bytes). A block with 6 blobs carries roughly 768 KiB of blob data alone, on top of the execution payload.

Blobs are gossiped separately from the block itself via the blob sidecar gossip topic. A validator needs both the block *and* all its blob sidecars to verify and attest. If any sidecar arrives late, the validator is blocked — it can't verify the KZG commitment without the blob.

Looking at `beacon_block_v2` data from xatu, grouped by blob count:

| Blobs | Median block seen delay (ms) | P90 delay | P99 delay |
|-------|------------------------------|-----------|-----------|
| 0     | 112                          | 298       | 891       |
| 1–2   | 128                          | 341       | 1,102     |
| 3     | 151                          | 389       | 1,287     |
| 4–5   | 174                          | 441       | 1,489     |
| 6     | 198                          | 511       | 1,744     |

The median delay for a full 6-blob block is ~76% higher than for an empty block. The P99 nearly doubles.

These numbers come from measuring the time between slot start and when the node first sees a complete block (block + all sidecar data), aggregated across ~2 million blocks.

## How this maps to attestation miss rates

Validators are supposed to broadcast attestations at 1/3 of the way into a slot (roughly 4 seconds after slot start). If they haven't seen the block by then, they either attest to no block (and miss the source/target reward entirely) or delay and take the inclusion penalty.

A propagation delay of 198ms median sounds fine — but P90 at 511ms and P99 at 1,744ms tells a different story. For 1% of high-blob blocks, propagation is slow enough that some validators on slow connections or in distant regions simply miss the window.

The effect is measurable in attestation inclusion rates. Blocks with 5–6 blobs have a ~0.3% higher attestation miss rate than blocks with 0–2 blobs. That sounds tiny, but:

- There are ~7,200 slots per day
- Roughly 30–40% of recent slots have 4+ blobs
- That's ~2,500 high-blob slots per day
- At 0.3% higher miss rate × ~500,000 attesting validators × reduced reward per miss

The daily reward drain attributable to blob propagation latency across the whole validator set is in the range of **4–8 ETH/day**. Not catastrophic. Not ignorable either.

## The compounding problem for Fulu

Fulu raises the blob target from 3 to 6 and the max from 6 to 9 (tentative, pending EIP-7742 parameter decisions). The propagation cost doesn't scale linearly — it's sublinear because blobs can be pipelined across peer connections. But it doesn't disappear either.

At 9 blobs per block:
- Blob data per block: ~1.15 MiB
- P99 propagation delay: estimated ~2.4 seconds at current p2p bandwidth

2.4 seconds is enough to push meaningful numbers of validators past the attestation window. This is why Fulu pairs the blob limit increase with improvements to blob gossip: PeerDAS allows a validator to verify the block without having all blobs locally, using KZG polynomial commitments. You only need your assigned column samples, not the full 9 blobs.

Without PeerDAS, raising blob limits directly raises the attestation miss rate. The math isn't complicated.

## Why proposers don't fully internalize this cost

The proposer who includes 6 blobs collects the blob fees. They don't pay the attestation miss penalty — that's distributed across all validators who get a slightly smaller reward. It's a classic externality: the benefit of including more blobs is private, the propagation cost is socialized.

This is partly why EIP-4844 introduced a blob fee market in the first place — to price the bandwidth externality. But the fee market prices *block space scarcity*, not *propagation latency*. A full blob block is more expensive than an empty one, but the fee doesn't scale with your distance from the proposer or your peer connection speed.

The result: proposers rationally fill blocks to the blob limit even when doing so imposes meaningful propagation costs on the rest of the network.

## The takeaway

Blobs are not free to propagate. At the current 6-blob limit, the cost is manageable but visible — roughly 4–8 ETH/day in distributed reward loss, with P99 propagation delays approaching 2 seconds. As the limit grows, the cost grows with it.

PeerDAS is the right long-term answer. For now, running validators near the median propagation path (good peering, low-latency connections to major relay nodes) is worth the engineering effort. The difference between P50 and P99 propagation speed is entirely within a validator operator's control — and right now, it maps directly to attestation reward performance.
