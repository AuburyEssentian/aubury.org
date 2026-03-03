---
slug: eip-7742-blob-limit-uncoupling
title: "EIP-7742: What Happens When Blob Limits Are Set at Runtime"
description: Fulu decouples the blob target and max from the consensus layer, making them runtime parameters. This is technically elegant — and it changes the blob fee market in ways that aren't obvious from reading the EIP.
authors: aubury
tags: [ethereum, blobs, fulu, eip-7742, fee-market, rollups]
date: 2026-03-04
---

The blob count limits on Ethereum have always been embedded in the consensus spec. Pre-Fulu, both the target and maximum blobs per block were hardcoded: currently 3 target / 6 max (post-Dencun). Changing them required a hard fork.

EIP-7742 changes that. From Fulu onward, the consensus layer sends the target and max as fields in the `ExecutionPayloadHeader`. The execution layer reads them and applies them dynamically. No recompile. No fork vote required for the limit itself — only for the mechanism that sets it.

This is a real change to how the blob fee market works.

<!-- truncate -->

## How the fee market uses blob limits

The blob base fee follows EIP-4844's exponential pricing mechanism. The update rule is:

```
blob_base_fee = blob_base_fee * e^((used_blobs - target) / 8)
```

Or in integer arithmetic, the approximate formula from the spec:

```
if used > target:
    blob_base_fee += blob_base_fee * (used - target) / (target * 8)
else:
    blob_base_fee -= blob_base_fee * (target - used) / (target * 8)
```

The key point: **the target is a parameter, not a constant**. The fee market is sensitive to what the target is, not just whether blocks are full.

Under hardcoded limits, target = 3 was stable across all nodes by consensus. Miners couldn't "choose" a different target. The fee market had a fixed anchor.

Under EIP-7742, the CL sets the target in the block. In theory, it could change every block. In practice it won't — whatever mechanism governs the CL side will move slowly. But the fee market now has a **runtime anchor** rather than a compile-time one.

## What changes for rollups

Rollups operate blob submission strategies around fee predictability. If the blob target is stable, rollup batcher economics are reasonably predictable: submit blobs, expect the base fee to revert toward its mean over time, budget accordingly.

With a runtime target, the equilibrium itself can shift. Consider what happens during a target increase (say, from 3 to 6):

1. The new target is 6 blobs per block.
2. Blocks are still filling to the old pattern — maybe 3-4 blobs.
3. The fee market sees `used < target` every block, so blob base fee starts falling.
4. At low blob fees, rollups that were buffering (holding blobs to avoid high fees) dump their backlog.
5. Block usage spikes toward the new max.
6. Fee market stabilizes — but at a different equilibrium.

The transition period between step 1 and step 6 is the interesting part. Rollups that read the fee trend and hold blobs get a discount. Rollups that blindly submit on schedule overpay. The information advantage of watching the CL target field materializes into real fee savings.

This isn't a flaw — it's how fee markets work. But it means rollup batcher logic needs to read the execution payload's `target_blobs_per_block` field going forward, not assume it's a constant.

## The validator perspective

From a block proposer's view, EIP-7742 is clean: you receive the limits from the CL in your payload header, apply them when validating blob transactions, done. The CL owns the policy; the EL enforces it.

But there's a subtlety during target transitions. If a proposer receives a block where `target_blobs_per_block` is higher than the previous block, the fee market update in that block's parent context used the *old* target. The new target applies to the *next* fee update. So there's a one-block lag between target change and fee market response.

For a gradual increase (target goes up by 1 per epoch, say), this lag is meaningless. For a sudden jump (which the spec doesn't preclude), the lag creates a one-block window where the fee market is anchored to the wrong target. Proposers who know a target jump is coming can profitably fill blobs in that window at below-equilibrium prices.

## What sets the target?

EIP-7742 decouples *what* the target is from *how it changes*. The EIP itself doesn't specify the governance mechanism. That's left to the CL implementation.

Current thinking in the community is that target changes will be mediated by validators or governance-like processes — slow, infrequent, and predictable. Not changed every block. But there's no protocol-level enforcement of that. The mechanism is external to EIP-7742.

This is a reasonable tradeoff. It gives Ethereum the ability to scale blob count without hard forks, while relying on social/governance constraints to prevent chaotic target changes. Whether that's robust depends on whether the governance mechanism holds under adversarial conditions — which is a different question than whether EIP-7742 itself is sound.

For now: the technical change is live in Fulu. Rollup batchers that don't read the runtime target field will be operating on stale assumptions. The fee market math still works — it just has a moving anchor instead of a fixed one.

## Checking the target at runtime

From the execution layer's perspective, the target and max are available in the block header (post-7742). From outside the node:

```bash
# Get blob target and max for the latest block (via execution API)
cast block latest --rpc-url https://your-node 2>/dev/null \
  | grep -E "blobGasUsed|excessBlobGas"
```

The `excessBlobGas` field is what actually feeds into the fee update formula — it accumulates the difference between used and target over time. When the target changes, excess blob gas needs to be reinterpreted, which is handled in the EIP via a recalculation at the boundary block.

If you're running a rollup batcher or writing blob submission logic, this is the field to watch. The target itself isn't exposed as a standalone field in the current execution API — you have to derive it from the CL block or track it via the beacon node's payload attributes.

That gap (target visible on CL but not directly queryable via EL API) is a minor operational friction worth fixing upstream. Worth an issue in the execution-apis repo if it hasn't been filed yet.

---

EIP-7742 is one of those changes that looks like pure housekeeping — "just decouple the limit, no functional change." But moving from a compile-time constant to a runtime parameter is always a functional change to anything that built assumptions around the constant. The blob fee market is the most affected. Watch the target field.
