---
slug: gloas-lighthouse-blob-route
title: Lighthouse called a Gloas block pre-Deneb
description: All 14 Platåberget Lighthouse endpoints served a Fulu blob, then rejected a valid Gloas blob query as pre-Deneb while 69 reachable peers returned identical bytes.
authors: aubury
tags: [ethereum, lighthouse, gloas, peerdas, beacon-api, devnet, data]
date: 2026-08-30
---

The request was boring: return one blob by versioned hash from canonical Gloas slot 116,671. All 14 Lighthouse nodes answered that the block was pre-Deneb. The same fleet served the same API route for a Fulu control, while every reachable Grandine, Lodestar, Nimbus, Prysm and Teku node returned the expected 131,072-byte blob.

<!-- truncate -->

<a href="/img/gloas-lighthouse-blob-route.png">
  <img src="/img/gloas-lighthouse-blob-route.png" alt="Matrix of all 84 public Platåberget supernode endpoints for one valid blob hash at Gloas slot 116,671. All 14 Lighthouse endpoints return a wrong pre-Deneb HTTP 400. Grandine, Lodestar, Nimbus and Prysm return the same exact blob on all 14 endpoints; 13 reachable Teku endpoints do too, with one endpoint unavailable. A control shows the same 14 Lighthouse nodes successfully serving a blob from Fulu slot 49,087." loading="eager" />
</a>

## One block, 84 endpoints

I froze one unambiguous block before touching the API. `fct_block FINAL` marks root `0x1277…f86a` at slot 116,671 as canonical and Gloas. The payload model and the raw signed-bid table agree on its execution block hash, builder index and four blob commitments.

```sql
SELECT
  slot,
  block_root,
  block_hash,
  parent_block_hash,
  builder_index,
  blob_kzg_commitment_count,
  slot_start_date_time
FROM `glamsterdam-devnet-8`.fct_block_payload FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-29 16:54:12')
  AND slot_start_date_time <  toDateTime('2026-08-29 16:54:24')
  AND block_root = '0x1277d83e1c145fb0169c16c2fc01b1ed6c21900757923de70ec2fd01b2edf86a';
```

The first KZG commitment hashes to versioned hash `0x01da4e68…18f45b`. I sent that exact filter to `/eth/v1/beacon/blobs/116671` on every supernode listed in the [public devnet inventory](https://github.com/ethpandaops/glamsterdam-devnets/blob/dd6412d092a85cb8a31ed6d026cc1bc8ecfcba65/ansible/inventories/devnet-8/inventory.ini), selecting nodes by their exact Dugtrio endpoint names rather than a client-level load balancer.

Lighthouse was perfectly consistent: **14 of 14 endpoints returned HTTP 400** with `BAD_REQUEST: block is pre-Deneb and has no blobs`. All were running `Lighthouse/v8.2.2-cec56ae`. Grandine, Lodestar, Nimbus and Prysm went 14 for 14; 13 reachable Teku endpoints did too. Every one of those 69 successful responses contained one 131,072-byte blob with SHA-256 `59f9f3cc…371f4e`.

The remaining Teku endpoint returned a bare HTTP 500 for both the blob request and `/eth/v1/node/version`, so I marked it unavailable. It is not evidence of a Teku blob-route failure. That leaves a clean implementation result among reachable nodes: 69 exact responses outside Lighthouse, 14 identical wrong responses inside it.

## The fork boundary is clean

A single current-version cohort can still hide an ordinary fleet outage. The Fulu control makes that explanation hard to sustain. I selected canonical slot 49,087, the final observed blob block before Gloas activation at epoch 1,536. Its execution payload carried seven blobs.

```sql
SELECT
  slot,
  block_root,
  block_version,
  status,
  execution_payload_blob_gas_used / 131072 AS blob_count,
  slot_start_date_time
FROM `glamsterdam-devnet-8`.fct_block FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-20 07:37:24')
  AND slot_start_date_time <  toDateTime('2026-08-20 07:37:36')
  AND block_root = '0xe6bbd4ad2e602606eed1ae6f1d41ed37fb7215d1e82f15c93b5d6874b3f7e6a5';
```

I derived one valid versioned hash from that block and repeated the request against the same 14 Lighthouse endpoint names. All 14 returned HTTP 200, one raw blob, and the same blob hash. The route worked, the nodes had historical data, and the deployed binary could apply the versioned-hash filter. Moving from a valid Fulu block/hash pair to a valid Gloas pair flipped the entire Lighthouse row from green to red.

## The commitment moved; the lookup did not

Gloas no longer stores blob KZG commitments in `BeaconBlockBody`. They live in the signed execution-payload bid. The deployed Lighthouse blob handler still called the old body-level commitment accessor; when that accessor found no pre-Gloas field, the API translated absence into the wonderfully wrong sentence `block is pre-Deneb`.

Lighthouse [issue #9933](https://github.com/sigp/lighthouse/issues/9933) reported the same error against a Gloas block. [PR #9937](https://github.com/sigp/lighthouse/pull/9937), opened while I was running the fleet probe, changes the route to read commitments from the signed bid and to reconstruct raw blobs from PeerDAS data columns. It was still open and unmerged at the cutoff, so this post does not claim the patch is deployed or fixed.

This is narrower than a blob-availability incident. Other clients returned identical bytes, and the Lighthouse failure happens in a Beacon API lookup before it can return them. It is also devnet evidence from one client build, not a Mainnet claim. But it is not a toy unit test either: every public Lighthouse supernode hit the same fork-boundary mistake, while the same binaries served the pre-fork control correctly.

Nothing was wrong with the blob. Lighthouse looked where the commitment used to live.
