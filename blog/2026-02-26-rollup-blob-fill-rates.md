---
slug: rollup-blob-fill-rates
title: "Not All Blobs Are Full: A Rollup Efficiency Breakdown"
authors: [aubury]
tags: [ethereum, blobs, rollups, eip-4844, data-availability]
---

Each blob on Ethereum costs the same regardless of how much data you actually put inside it. The slot doesn't know if you packed all 131,072 bytes or left 99% empty. You pay either way.

That flat pricing creates a question that hasn't been answered cleanly: how efficiently are rollups actually using the space they're buying? The answer turns out to span an enormous range — from 100% fill all the way down to a rollup that's posting the same completely empty blob, over and over, every block.

<!-- truncate -->

![Rollup blob fill rate by chain](/img/rollup-blob-fill-rates.png)

```
Query: ethpandaops xatu — canonical_beacon_blob_sidecar × mainnet.dim_block_blob_submitter
Method: per versioned_hash, match blob_empty_size to rollup address via dim table
Window: Feb 19–26, 2026 (7-day average, mainnet)
```

Most of the chart is green. That's the story for the largest rollups — StarkNet, Arbitrum, Unichain, OP Mainnet, Soneium, Base — all packing their blobs at 96–100%. When you post 5–6 blobs per transaction and batch until they're full, you end up near capacity almost automatically. These chains have figured out the right posting cadence.

Then the bottom of the chart starts getting uncomfortable.

**Mantle** fills its blobs at 32.5%. Every blob transaction it sends contains roughly one-third useful data and two-thirds zeros. It posts ~1,240 blobs per week — if it batched to full capacity, it would need about 400.

**Katana** is at 15.5%. One blob per transaction, roughly 1 in 6.5 bytes of actual data.

**Taiko** comes in at 8.8% fill across three batcher addresses, totaling 1,072 blobs per week. The useful data in those 1,072 blobs would fit comfortably in about 94 full blobs. Taiko is posting 11× more often than it needs to.

**Metal** is 0.56% fill. 

That number deserves a pause. Each Metal blob holds an average of ~730 bytes of actual data inside a 131,072-byte envelope. The waste ratio against Arbitrum — which fills its blobs at 99.8% — is roughly 178×. Metal posts 2,452 blobs per week and transfers about 1.3 MB of useful data. If it packed blobs fully, that's fewer than 11 blobs.

The cost math is simple: blob gas is priced per blob, not per byte. A rollup with 0.56% fill is paying per byte as if 131 KB of data had the same cost as the actual ~730 bytes. That's not theoretical waste — it's blob fees going out the door.

The mechanism behind these gaps isn't mysterious. Rollups that post at 97–100% are the ones that accumulate data until they've collected enough to fill multiple blobs, then batch everything in one transaction. When you post 3 blobs, you have 393 KB to fill. If your chain has enough throughput to generate that data between posting intervals, you'll be near capacity. 

Rollups that post 1 blob per block every block — Metal, Taiko, Katana, Mantle — don't wait. Whatever data has accumulated since the last post goes out immediately, regardless of how little it is. For high-traffic chains, that's fine; the data fills up fast. For lower-throughput chains, it means paying full blob cost for a fraction of the space.

The Aztec case is different. Aztec posts exactly one blob per transaction, once per block, at 0% fill — not 0.56%, literally zero useful bytes. More unusual: every single Aztec blob transaction in the past week uses the **same versioned hash**.

```
Query: dim_block_blob_submitter WHERE address = '0x7342404...'
→ 1,284 transactions, unique_first_hashes = 1
→ versioned_hash = 0x010657f37554c781402a22917dee2f75def7ab966d7b770905398eba3c444014
→ blob_size = 131072, blob_empty_size = 131072 (all zeros)
```

A versioned hash is derived from the KZG commitment to the blob's content. Identical hash means identical content — all zeros, every time. Aztec appears to be posting a canonical null blob as a protocol heartbeat, maintaining sequencer liveness on-chain even when no user transactions are pending. Whether this is an intentional design or a configuration artifact isn't clear from the chain data, but the pattern is consistent across 1,284 blocks last week.

The efficiency divergence between rollups isn't hidden — it's just not usually visualized this way. The blob market looks like one thing from the outside (flat-rate pricing, relatively cheap, widely adopted) but is doing very different economic work for different chains underneath. Chains that wait to batch full pay roughly the same fee per byte as chains that don't. The difference accrues over thousands of weekly blobs.

For Taiko at 8.8% fill, upgrading to a batching strategy that targets 80% fill would reduce their blob spend by roughly 90% while publishing exactly the same data. The blobs exist either way — it's a question of whether you fill them before paying.

---

*Blob fill rates computed from `blob_size` and `blob_empty_size` fields in `canonical_beacon_blob_sidecar`, joined to submitter identity via `mainnet.dim_block_blob_submitter.versioned_hashes`. All data from ethpandaops xatu, Feb 19–26 2026, Ethereum mainnet. Rollups with fewer than 400 blobs in the window are excluded. Aztec's zero-fill confirmed by checking unique versioned hash diversity over 7 days.*
