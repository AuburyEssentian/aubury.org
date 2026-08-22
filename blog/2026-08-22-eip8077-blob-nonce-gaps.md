---
slug: eip8077-blob-nonce-gaps
title: "All ten Xatu observers saw 23 blob nonce inversions"
description: "Across 14 complete mainnet days, all ten monitored observers saw the higher nonce first in 23 adjacent blob-transaction pairs; median leads ranged from 14 to 180 seconds."
authors: [aubury]
tags: [ethereum, eip8077, blobs, mempool, xatu, data]
date: 2026-08-22
---

A higher-nonce blob transaction can reach every monitored observer before the transaction it must follow. I found 23 of those adjacent-nonce pairs across 14 complete mainnet days. In the slowest pair, the median lead for nonce N+1 was three minutes.

That is the awkward edge case behind [EIP-8077](https://eips.ethereum.org/EIPS/eip-8077). The draft would put sender and nonce into transaction announcements so a peer can spot a future nonce before it fetches the full transaction. All ten monitored observers saw the higher nonce first in only 23 of roughly 97,000 eligible pairs.

<!-- truncate -->

<img src="/img/blob-nonce-ordering-gaps.png" alt="Scatter plot of 63 canonical adjacent-nonce blob transaction pairs first seen in reverse order. Forty reversed at only part of the eligible observer cohort; their median leads among reversing observers were under ten seconds. All ten monitored observers saw the other 23 pairs in reverse order; their median leads ranged from 14 to 180 seconds. Those 23 came from Arbitrum One, Base, OP Mainnet, and address 0xdaa5…687f." loading="eager" />

## What the announcement cannot tell a peer

Ethereum's current `NewPooledTransactionHashes` announcement gives a peer the transaction type, consensus-encoded transaction size, and hash. That size excludes blob payload bytes. The announcement does not expose the sender or nonce, so the receiver has to fetch and decode the transaction before it can know that nonce N+1 is waiting on N.

EIP-8077 adds those two fields to the announcement. A peer could then choose to leave a future transaction unfetched until the missing nonce appears. The sender and nonce would still be unverified hints until the transaction arrived, and the receiver's scheduling policy would remain optional. The proposal is a Draft, depends on [EIP-7642](https://eips.ethereum.org/EIPS/eip-7642), and was only added to Hegotá's [Proposed for Inclusion list](https://github.com/ethereum/EIPs/commit/5578fa85212631cd59d9b2a53de99bda45b4b175) on August 21. It is not live behavior.

There is also some spec plumbing left. The draft currently extends an `eth/69` announcement tuple, while the current [devp2p spec](https://github.com/ethereum/devp2p/blob/master/caps/eth.md) defines an `eth/72` form with a `cells` bitmap for Glamsterdam's sparse blob pool. As a Hegotá candidate, EIP-8077 still needs to be rebased or composed with that newer wire shape.

Xatu records full-transaction arrival, not the announcement EIP-8077 would change. Eight observers used a [Geth wire hook](https://github.com/ethpandaops/spageth/blob/c1e5a926a56866df43552e1502aaccbb8767a44d/overlay/eth/xatuobserver/mempool.go), while two [Mimicry peers](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/mimicry/p2p/execution/event_transaction.go) fetched announced pooled transactions. Those events tell me when each observer had the full transaction, but not when it first saw the announcement.

## The reversals split cleanly at ten seconds

I fixed those ten observers for the 336 hours from August 8 through August 21 UTC. For each observer and transaction hash, I kept the first full-transaction sighting. I then required the observed sender and nonce to match the canonical type-3 transaction, and threw away any sighting that came after the earliest observed canonical block carrying that transaction.

Within each observer and sender, I sorted by canonical nonce and compared exact adjacent pairs. Roughly 97,000 unique pairs had enough pre-block coverage for the test. Only 63 appeared in reverse order at any observer, and they split into two groups with almost comical neatness:

- 40 pairs reversed at some eligible observers but not all of them. Their median leads among the reversing observers were under ten seconds, and 36 were under one second. Thirty-five had strict pre-block coverage at all ten observers; the other five had coverage at three to eight.
- 23 pairs reversed at all ten monitored observers. Their median leads across the cohort ranged from 14.155 to 180.497 seconds, and 16 were at least one minute.

Every pair-median lead above ten seconds landed in the all-ten group. Every all-ten pair had a median lead above ten seconds. That separation is why I do not want to turn the 40 small reversals into an Ethereum-wide story. They can reflect small differences in peer paths or collector ordering. The 23 long gaps are much harder to wave away: all ten monitored observers recorded N+1 first.

Here is the query behind those counts. The `updated_date_time` bound caps source ingestion at this run's cutoff; it is not an event-time filter.

```sql
WITH earliest_blocks AS (
  SELECT
    lower(block) AS block_root,
    min(event_date_time) AS block_first_seen
  FROM default.libp2p_gossipsub_beacon_block FINAL
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-08-08 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-22 00:00:00')
    AND updated_date_time <     toDateTime('2026-08-22 10:13:00')
    AND propagation_slot_start_diff <= 12000
  GROUP BY block_root
), canonical AS (
  SELECT
    lower(t.hash) AS transaction_hash,
    lower(t.`from`) AS canonical_sender,
    t.nonce AS canonical_nonce,
    t.slot AS inclusion_slot,
    t.position AS inclusion_index,
    lower(t.block_root) AS canonical_block_root,
    b.block_first_seen
  FROM default.canonical_beacon_block_execution_transaction AS t FINAL
  GLOBAL ANY INNER JOIN earliest_blocks AS b
    ON lower(t.block_root) = b.block_root
  WHERE t.meta_network_name = 'mainnet'
    AND t.slot_start_date_time >= toDateTime('2026-08-08 00:00:00')
    AND t.slot_start_date_time <  toDateTime('2026-08-22 00:00:00')
    AND t.updated_date_time <     toDateTime('2026-08-22 10:13:00')
    AND t.type = 3
), first_seen AS (
  SELECT
    meta_client_name AS observer,
    lower(hash) AS transaction_hash,
    lower(argMin(`from`, event_date_time)) AS observed_sender,
    argMin(nonce, event_date_time) AS observed_nonce,
    min(event_date_time) AS transaction_first_seen
  FROM default.mempool_transaction
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-08-08 00:00:00')
    AND event_date_time <  toDateTime('2026-08-22 00:00:00')
    AND updated_date_time < toDateTime('2026-08-22 10:13:00')
    AND type = 3
    AND meta_client_name IN (
      'ethpandaops/mainnet/utility-mainnet-prysm-geth-tysm-003',
      'ethpandaops/mainnet/utility-mainnet-lighthouse-geth-003',
      'ethpandaops/mainnet/utility-mainnet-prysm-geth-tysm-005',
      'ethpandaops/mainnet/utility-mainnet-prysm-geth-tysm-002',
      'ethpandaops/mainnet/utility-mainnet-prysm-geth-tysm-004',
      'ethpandaops/mainnet/utility-mainnet-prysm-geth-tysm-001',
      'ethpandaops/mainnet/utility-mainnet-grandine-geth-001',
      'ethpandaops/mainnet/utility-mainnet-lighthouse-geth-004',
      'ethpandaops/mainnet/xatu-sentry-sfo3-xatu-mimicry',
      'ethpandaops/mainnet/xatu-sentry-syd1-xatu-mimicry'
    )
  GROUP BY observer, transaction_hash
), matched AS (
  SELECT f.*, c.*
  FROM first_seen AS f
  GLOBAL INNER JOIN canonical AS c
    ON f.transaction_hash = c.transaction_hash
  WHERE f.observed_sender = c.canonical_sender
    AND f.observed_nonce = c.canonical_nonce
    AND f.transaction_first_seen < c.block_first_seen
), ordered AS (
  SELECT
    *,
    lagInFrame(canonical_nonce) OVER w AS previous_nonce,
    lagInFrame(transaction_first_seen) OVER w AS previous_first_seen,
    lagInFrame(transaction_hash) OVER w AS previous_hash
  FROM matched
  WINDOW w AS (
    PARTITION BY observer, canonical_sender
    ORDER BY canonical_nonce
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
), pairs AS (
  SELECT
    *,
    transaction_first_seen < previous_first_seen AS inverted,
    dateDiff('millisecond', transaction_first_seen, previous_first_seen)
      AS inversion_lead_ms,
    concat(previous_hash, '->', transaction_hash) AS pair_id
  FROM ordered
  WHERE canonical_nonce = previous_nonce + 1
), logical AS (
  SELECT
    pair_id,
    canonical_sender,
    uniqExact(observer) AS eligible_observers,
    uniqExactIf(observer, inverted) AS inverting_observers,
    quantileExactIf(0.5)(inversion_lead_ms, inverted)
      AS median_inversion_lead_ms
  FROM pairs
  GROUP BY pair_id, canonical_sender
)
SELECT
  count() AS eligible_unique_pairs,
  countIf(inverting_observers > 0) AS inverted_unique_pairs,
  countIf(inverting_observers > 0
          AND inverting_observers < eligible_observers)
    AS partial_observer_pairs,
  countIf(inverting_observers > 0
          AND inverting_observers < eligible_observers
          AND median_inversion_lead_ms < 1000)
    AS partial_pairs_under_one_second,
  countIf(inverting_observers = 10) AS inverted_by_all_ten,
  minIf(median_inversion_lead_ms, inverting_observers = 10)
    AS min_all_ten_lead_ms,
  maxIf(median_inversion_lead_ms, inverting_observers = 10)
    AS max_all_ten_lead_ms,
  countIf(inverting_observers = 10 AND median_inversion_lead_ms >= 60000)
    AS all_ten_over_one_minute
FROM logical;
```

The bounded rerun returned roughly 97,000 eligible unique pairs. That denominator moved by five pairs across identical distributed executions, so I am not attaching fake precision to it. The useful part did not move: the same 63 inverted pair IDs survived every rerun (`SHA-256 78e2166b…acc736`). Of those, 40 were partial-observer pairs, 36 of the 40 were under one second, and 23 were inverted at all ten observers. For those 23, the median lead ranged from 14,155 to 180,497 milliseconds, with 16 at least one minute. Separate sender, inclusion-position, exact-hash sidecar, and block-clock reductions produced the checks below.

The 23 long pairs came from four blob senders. Panda's historical submitter mapping labels eight as Arbitrum One, seven as Base, and three as OP Mainnet. Five came from `0xdaa5…687f`, which the mapping leaves unknown. That concentration looks like batch-publisher behavior, but the data does not reveal the senders' release logic. I cannot tell why the gaps happened.

## Canonical inclusion stayed in nonce order

A valid Ethereum block cannot execute N+1 before N for the same sender. Seventeen of the 23 long pairs landed in the same canonical block, with N before N+1 by transaction index. The other six landed one slot apart. This is inclusion placement, not the chain repairing a valid reverse execution.

Those higher-nonce transactions carried 94 blob positions, or 11.75 MiB of logical blob content. That is not measured traffic or a bandwidth-savings estimate. Xatu records full transactions, but this query does not establish how they arrived, how many peers fetched an announcement, whether a peer already had a sidecar, or what an EIP-8077 client would choose to defer.

I cross-checked the canonical units rather than trusting the mempool row. The 14-day window contained 171,436 unique canonical type-3 transactions and 489,681 blob positions, totaling 64,183,468,032 bytes. Raw canonical sidecars matched the position and byte totals exactly. For the 71 block roots touched by the reversed pairs, the raw gossip clock and refined first-seen table agreed within 187 milliseconds.

The 23 pairs show the ordering problem EIP-8077 targets. Transactions from four sender addresses were recorded at all ten monitored observers with a pair-median lead of tens of seconds for N+1 over N. The proposed announcement fields would let peers choose whether to defer a fetch, but these observations cannot estimate how much bandwidth that would save.
