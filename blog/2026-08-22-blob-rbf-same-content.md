---
slug: blob-rbf-same-content
title: "99.59% of blob fee bumps kept the same blob"
description: "Across 3,427 current mainnet blob-transaction replacement edges, 3,413 kept the exact same versioned-hash array. The blob-aware mempool proposal is aimed at a very real redundancy."
authors: aubury
tags: [ethereum, eip-8094, blobs, mempool, data]
date: 2026-08-22
---

Blob transactions have an expensive way to say "same data, higher fee." The transaction hash changes, so the network pulls the whole thing again, including blob content it may already have.

[EIP-8094](https://eips.ethereum.org/EIPS/eip-8094) proposes splitting those pieces apart. I checked the premise against 14 complete days of mainnet mempool observations. Out of **3,427 consecutive same-sender, same-nonce blob fee increases, 3,413 kept the exact same versioned-hash array**. That is **99.59%**.

<!-- truncate -->

<img src="/img/blob-rbf-same-content.png" alt="Across 3,427 same-sender same-nonce type-3 fee increases, 3,413 or 99.59% kept the exact blob versioned-hash array. Those edges contained 4,947 already-seen blob positions, or 618.4 MiB of exact blob content. All 14 changed-content edges carried one blob, while every 2-to-6-blob edge reused its full hash array." loading="eager" />

This is not a fork feature yet. EIP-8094 is a Draft, and it was only added to Hegotá's [Proposed for Inclusion list](https://github.com/ethereum/EIPs/commit/5578fa85212631cd59d9b2a53de99bda45b4b175) on August 21. The draft still has an unassigned message code and a few literal TODOs. Rough edges aside, the waste it targets is easy to find.

## The same nonce, almost always the same blob

I used ten observers that recorded mempool traffic in all 336 hours from August 7 through August 20 UTC. For each observer I reduced repeated reports to the first sighting of a transaction hash. I then pooled those first sightings, grouped distinct type-3 hashes by sender and nonce, sorted each group by time, and compared consecutive versions.

Every retained edge raised at least one of the execution fee cap, tip cap, or blob fee cap. I call them replacement-shaped edges rather than accepted replacements because the table records what the observers received, not each execution client's final txpool decision.

Here is the query that produced the headline:

```sql
WITH eligible AS (
  SELECT meta_client_name AS observer
  FROM default.mempool_transaction FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-08-07 00:00:00')
    AND event_date_time <  toDateTime('2026-08-21 00:00:00')
  GROUP BY observer
  HAVING uniqExact(toStartOfHour(event_date_time)) = 336
     AND uniqExactIf(hash, type = 3) > 0
), per_hash AS (
  SELECT
    `from` AS sender,
    nonce,
    hash AS tx_hash,
    min(event_date_time) AS first_seen,
    argMin(blob_hashes, event_date_time) AS vhashes,
    argMin(gas_fee_cap, event_date_time) AS max_fee,
    argMin(gas_tip_cap, event_date_time) AS max_tip,
    argMin(blob_gas_fee_cap, event_date_time) AS max_blob_fee
  FROM default.mempool_transaction FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-08-07 00:00:00')
    AND event_date_time <  toDateTime('2026-08-21 00:00:00')
    AND type = 3
    AND meta_client_name GLOBAL IN (SELECT observer FROM eligible)
  GROUP BY sender, nonce, tx_hash
), per_nonce AS (
  SELECT
    sender,
    nonce,
    arraySort(x -> (x.1, x.2), groupArray((
      first_seen, tx_hash, vhashes, max_fee, max_tip, max_blob_fee
    ))) AS versions
  FROM per_hash
  GROUP BY sender, nonce
  HAVING length(versions) > 1
), edges AS (
  SELECT
    sender,
    nonce,
    arrayJoin(range(1, length(versions))) AS edge_index,
    versions[edge_index] AS old_v,
    versions[edge_index + 1] AS new_v
  FROM per_nonce
)
SELECT
  count() AS replacement_edges,
  uniqExact(tuple(sender, nonce)) AS nonce_episodes,
  uniqExact(sender) AS senders,
  countIf(old_v.3 = new_v.3) AS exact_same_vhash_array,
  sum(length(new_v.3)) AS replacement_blob_positions,
  sum(length(arrayIntersect(old_v.3, new_v.3))) AS reused_blob_positions,
  sum(toUInt64(length(arrayIntersect(old_v.3, new_v.3))) * 131072)
    AS reusable_blob_bytes,
  countIf(new_v.4 > old_v.4 OR new_v.5 > old_v.5 OR new_v.6 > old_v.6)
    AS edges_with_fee_cap_increase
FROM edges;
```

The 3,427 edges came from 2,713 sender-nonce episodes and 142 senders. They carried 4,961 blob positions in their newer versions. **4,947 positions reused a versioned hash from the immediately previous version**, or 99.72%. At 131,072 bytes per blob, that is **648,413,184 bytes, or 618.4 MiB**, of exact blob content represented in both versions.

The exceptions were oddly tidy. All 14 changed-content edges carried one blob. The 608 edges carrying two through six blobs kept their entire hash array. This was not one sender gaming the average either: the largest sender contributed 786 edges, 22.94% of the total, and 785 of those kept the same blob.

## Ten observers told the same story

The pooled reduction could hide a bad ordering decision, so I repeated it separately for every observer. The exact-reuse share landed between **99.5848% and 99.5904%** on all ten. Eight observers recorded the [first transaction batch seen on a Geth wire path](https://github.com/ethpandaops/spageth/blob/c1e5a926a56866df43552e1502aaccbb8767a44d/overlay/eth/xatuobserver/mempool.go), while two [Xatu Mimicry peers](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/mimicry/p2p/execution/event_transaction.go) fetched announced pooled transactions. The result did not care which capture path saw it.

I also checked the blob units against canonical data rather than trusting the mempool column name. Over the same dates, canonical type-3 transactions contained 481,113 blob positions and 63,060,443,136 blob bytes. Raw canonical sidecars contained exactly 481,113 unique `(slot, block_root, blob_index)` rows and the same byte total. Every sidecar was 131,072 bytes.

```sql
SELECT
  count() AS transaction_rows,
  uniqExact(hash) AS transaction_hashes,
  sum(length(blob_hashes)) AS transaction_blob_positions,
  sum(toUInt64(ifNull(blob_sidecars_size, 0))) AS transaction_blob_bytes,
  countIf(toUInt64(ifNull(blob_sidecars_size, 0))
          != toUInt64(length(blob_hashes)) * 131072) AS size_mismatches
FROM default.canonical_beacon_block_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-08-07 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-21 00:00:00')
  AND type = 3;
```

That returned 169,684 unique transaction rows, 481,113 blob positions, and zero size mismatches. The sidecar query returned the same 481,113 positions with zero duplicate semantic keys.

## This is not 618 MiB of measured savings

EIP-8094 would send a type-3 transaction without its sidecar, then let the receiver request missing blobs by versioned hash through `GetPooledBlobs`. The 618.4 MiB figure is the duplicate blob content inside this observed sequence. It is not a measurement of bytes sent over every peer connection, and it is not a claim that a receiver still had every old blob in memory when the replacement arrived.

The draft also adds a request and response exchange, changes propagation behavior, and still needs an assigned wire-protocol message code. Actual savings depend on peer fanout, cache retention, eviction, and how clients combine this proposal with sparse blob pools. Xatu does not expose those pieces here.

Still, the basic premise is stronger than I expected. In this cohort, a blob fee bump almost never meant new blob content. Ethereum kept redistributing the expensive part because the transaction hash gave peers no way to ask for just the cheap part.
