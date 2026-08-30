---
slug: lighthouse-blob-filter-order
title: Lighthouse let the blob filter reorder the block
description: Every reachable Platåberget Lighthouse supernode returned a two-blob filter in caller order [6, 0], while the Beacon API requires commitment order [0, 6] and five other clients followed it.
authors: aubury
tags: [ethereum, lighthouse, beacon-api, blobs, peerdas, devnet, data]
date: 2026-08-30
---

I asked Lighthouse for two blobs from one canonical Fulu block, listing commitment 6 before commitment 0. Every reachable Lighthouse supernode returned them as `[6, 0]`. That sounds like obedient filtering, but the Beacon API says the response follows the commitments in the block, so the correct order was `[0, 6]`.

<!-- truncate -->

<a href="/img/lighthouse-blob-filter-order.png">
  <img src="/img/lighthouse-blob-filter-order.png" alt="Comparison of a reversed two-hash blob request against Beacon API commitment order. Thirteen of thirteen reachable Lighthouse endpoints returned caller order 6 then 0, while nine reachable Grandine, Lodestar, Nimbus, Prysm and Teku controls returned commitment order 0 then 6. The blob bytes themselves matched exact SHA-256 controls." loading="eager" />
</a>

## The query is not the order

I reused a deliberately boring control from the previous Gloas route check: canonical Fulu slot 49,087, root `0xe6bb…e6a5`. Raw and refined block paths agree that it carried seven blobs. The literal time and root bounds matter here because I wanted one block body, not whichever block later occupied the same slot in an observer table.

```sql
SELECT
  slot,
  block_root,
  block_version,
  status,
  execution_payload_blob_gas_used,
  execution_payload_blob_gas_used / 131072 AS blob_count,
  slot_start_date_time
FROM `glamsterdam-devnet-8`.fct_block FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-20 07:37:24')
  AND slot_start_date_time <  toDateTime('2026-08-20 07:37:36')
  AND block_root = '0xe6bbd4ad2e602606eed1ae6f1d41ed37fb7215d1e82f15c93b5d6874b3f7e6a5';
```

That returned one canonical `fulu` row with `917504` blob gas, or seven blobs. I then pulled the ordered blob hashes from the raw transaction rows instead of trusting the filter response to identify itself.

```sql
SELECT
  position,
  hash,
  blob_hashes,
  blob_sidecars_size,
  blob_sidecars_empty_size
FROM `glamsterdam-devnet-8`.canonical_beacon_block_execution_transaction FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-20 07:37:24')
  AND slot_start_date_time <  toDateTime('2026-08-20 07:37:36')
  AND block_root = '0xe6bbd4ad2e602606eed1ae6f1d41ed37fb7215d1e82f15c93b5d6874b3f7e6a5'
  AND length(blob_hashes) > 0
ORDER BY position;
```

The query returned seven transaction rows, seven unique versioned hashes and 917,504 sidecar bytes. The first hash was `0x0116e081…9f1710`; the seventh was `0x01fd2bf2…120952`. Fetching each one alone gave blob SHA-256 values `7e47be75…49fa9a` for index 0 and `2a6c8a8b…876761` for index 6. The block's `/eth/v2/beacon/blocks` commitments independently derived the same seven versioned hashes in the same order.

Then I reversed only the query parameters:

```text
GET /eth/v1/beacon/blobs/0xe6bb…e6a5
  ?versioned_hashes=0x01fd2bf2…120952   # commitment index 6
  &versioned_hashes=0x0116e081…9f1710   # commitment index 0
```

The [Beacon API contract](https://github.com/ethereum/beacon-APIs/blob/master/apis/beacon/blobs/blobs.yaml) is explicit: filtering chooses which blobs are returned, but the returned list still matches their KZG commitment order in the block. In other words, the request was `[6, 0]` and the required response was `[0, 6]`.

## One client treated the filter as a sort key

Thirteen reachable Lighthouse supernodes, all reporting `Lighthouse/v8.2.2-fe4a464`, returned the two exact blob hashes as `[2a6c…6761, 7e47…fa9a]`: index 6, then index 0. Nine reachable controls across Grandine, Lodestar, Nimbus, Prysm and Teku returned `[7e47…fa9a, 2a6c…6761]`, which is index 0 then index 6. One Lighthouse endpoint was down and one Prysm control no longer held the historical block, so neither appears in the denominator.

The bytes were fine. Lighthouse returned both requested blobs, and each matched its single-hash SHA-256 control. The JSON shape was also fine: every response item was a flat hex string, not a `{blob: ...}` object. That rules out the second concern raised in the fresh issue and leaves one narrow failure: list position.

That position is not decoration. The response contains raw blobs without an attached commitment index or versioned hash, so a consumer following the spec aligns each item with the filtered commitments in block order. A consumer that silently assumes caller order can mask this bug in its own code; a spec-following consumer can label the two returned blobs backwards.

Lighthouse's source explains the fleet result without any guesswork. The handler walks `versioned_hashes` in request order, finds each hash's position in the block commitment list, collects those indices, then fetches blobs in the collected order. The caller's filter accidentally becomes a sort key.

[Lighthouse issue #9941](https://github.com/sigp/lighthouse/issues/9941) reported the deviation on August 30. [PR #9944](https://github.com/sigp/lighthouse/pull/9944) adds the missing `sort_unstable()` before blob retrieval and a reversed-hash regression test. The PR was still open, and the measured `fe4a464` build predates it, so this is current pre-fix devnet behavior rather than a claim about a deployed repair.

This is the same API route as the separate Gloas commitment-location failure, but it is not the same bug. I used a Fulu block precisely because the current Lighthouse fleet can serve it and the old body-level commitment path is valid there. No Gloas lookup, data-column reconstruction or blob-availability claim enters this result.

The filter chose which blobs came back. It was never supposed to rewrite their position.
