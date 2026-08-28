---
slug: sparse-blob-announcements-legacy-peers
title: The sampler advertised what it could not serve
description: One Geth sampler logged 163,752 failed legacy blob encodes in 60 hours after sparse transactions were announced to pre-eth/72 peers.
authors: aubury
tags: [ethereum, geth, eip-8070, glamsterdam, peerdas, data]
date: 2026-08-29
---

An Ethereum transaction announcement is an invitation: send the hash now, then let the other peer ask for the transaction. One Geth sampler on Glamsterdam devnet-8 spent 60 hours issuing invitations that its legacy peers could not cash. Its logs contain **163,752 failed full-blob encodes** across 42,537 truncated transaction labels.

<!-- truncate -->

<img src="/img/sparse-blob-announcements-legacy-peers.png" alt="Hourly chart of 163,752 failed legacy blob transaction encodes on one Glamsterdam Geth sampler from August 22 to 24, followed by a quiet period. The node restarted on August 24, four days before Geth PR 35589 merged, so the chart does not attribute the quiet period to the fix." loading="eager" />

## Two wire formats shared one pool

[EIP-8070](https://eips.ethereum.org/EIPS/eip-8070) makes the execution-layer blobpool sparse. A node fetches complete blob data for some transactions, but usually keeps only the cells aligned with its consensus client's custody set. A basic sampler can therefore hold 8 of the 64 cells, well short of the 64-cell reconstruction threshold.

The new `eth/72` wire format understands that shape. Its `NewPooledTransactionHashes` message carries a cell-availability bitmap, and peers fetch blob data with `GetCells`. Its `PooledTransactions` response leaves the blob list empty because the cells travel separately. The [current devp2p specification](https://github.com/ethereum/devp2p/blob/2c19a28b25c29487773ad6b07243e290fa8d65ec/caps/eth.md#blob-transaction-and-cell-exchange) keeps pre-`eth/72` peers alive during rollout, but those peers still ask for the older full-blob transaction encoding.

That compatibility lane had a bad edge. The Geth build running during this event, `aa1f2fcf`, [batched announcements by custody mask](https://github.com/ethereum/go-ethereum/blob/aa1f2fcf512988eb8890d9352e601b898d6fdb2c/eth/protocols/eth/broadcast.go#L120-L141), but it did not check whether the remote peer could retrieve what was being advertised. When a pre-`eth/72` peer sent `GetPooledTransactions`, Geth called `GetRLP` for each requested hash. The legacy branch then tried to [recover full blobs from the stored cells](https://github.com/ethereum/go-ethereum/blob/86696a8f430db77756a5d1ea9f55c2cf0d742a0e/core/txpool/blobpool/blobpool.go#L308-L327). With fewer than 64 cells, recovery failed, Geth logged the error, and the transaction was skipped from the response.

## Forty-two thousand hash labels hit the same wall

I counted the log line at its actual grain: one row is one failed transaction-encoding attempt. It is not a peer, a request packet, or a unique transaction. This is the exact bounded query:

```python
from ethpandaops import clickhouse

rows = clickhouse.query("clickhouse-raw", """
SELECT
  count() AS failed_encodes,
  uniqExact(tuple(
    Timestamp, Body, ResourceAttributes['host.name']
  )) AS unique_log_lines,
  uniqExact(ResourceAttributes['host.name']) AS reporting_hosts,
  uniqExact(extract(Body, 'hash=([^ ]+)')) AS truncated_hash_labels,
  countIf(positionCaseInsensitive(
    Body, 'not enough cells to perform reconstruction'
  ) > 0) AS not_enough_cells,
  min(Timestamp) AS first_seen,
  max(Timestamp) AS last_seen
FROM external.otel_logs
WHERE ResourceAttributes['network'] = 'glamsterdam-devnet-8'
  AND Timestamp >= toDateTime64('2026-08-22 00:00:00', 9, 'UTC')
  AND Timestamp <  toDateTime64('2026-08-24 12:00:00', 9, 'UTC')
  AND positionCaseInsensitive(
    Body, 'Failed to encode pooled tx into the network type'
  ) > 0
""")
```

The 163,752 rows were 163,752 distinct `(timestamp, body, host)` log lines, so duplicate ingestion did not inflate the count. Every row ended in `not enough cells to perform reconstruction`, and every row came from the same Geth host. Geth shortens hashes in its console output to six leading and six trailing hex characters, so **42,537 is a count of truncated hash labels**, not a canonical exact-hash set.

Even with that limitation, the repeat shape is clear. The median label failed four times, the 95th percentile failed eight times, and the busiest label failed 14 times. The peak hour produced 4,440 failed encodes. This was not one poisoned transaction hammering a loop; thousands of sparse transactions were repeatedly requested through a wire format that required complete blobs.

## The request counters agree on the protocol lane

Geth's protocol metrics give a separate view of the same fixed 60-hour window. I ran these PromQL expressions at the window's ending timestamp, `1787572800`:

```promql
increase(p2p_ingress_eth_71_0x09_packets{
  instance="glamsterdam-devnet-8-buildoor-lighthouse-geth-1"
}[60h]) @ 1787572800

increase(p2p_egress_eth_71_0x0a_packets{
  instance="glamsterdam-devnet-8-buildoor-lighthouse-geth-1"
}[60h]) @ 1787572800
```

Message `0x09` is `GetPooledTransactions`; `0x0a` is its response. The node received **3,015,709 `eth/71` request packets** and sent exactly 3,015,709 response packets. Over `eth/72`, the corresponding counts were 881,187 requests and 881,115 responses.

Those packet counters are not the failure denominator. A request can carry several hashes, while the error is emitted once per hash that reaches the failed encoding path. They do establish two useful facts without leaning on the log parser: the sampler was serving a large `eth/71` request lane, and `eth/72` traffic was active beside it.

## The restart is not the fix

The timing almost invites the wrong story. The final error landed at `2026-08-24 11:21:08.934 UTC`; one second later the node logged an interrupt and restarted on Geth commit `e5566cea`. A follow-up query found zero matching errors from August 24 at 12:00 UTC through August 29 at 00:00 UTC.

[Geth PR #35589](https://github.com/ethereum/go-ethereum/pull/35589) was not authored until August 26 and merged on August 28. It cannot explain why this error stream stopped on August 24. The restarted build did not contain the fix, and a later August 28 image at `86696a8f` was still two commits behind the merge while remaining quiet. Something about the triggering pool or request cohort changed across the restart; the available telemetry does not say which.

A live peer snapshot on August 28 found 46 connections on the same node: 1 negotiated `eth/69`, 19 used `eth/71`, and 26 used `eth/72`. That is not the historical peer denominator for the August 22-24 event, but it shows why the compatibility path still matters during rollout.

The merged patch adds the missing boundary. Geth now suppresses an announcement to a pre-`eth/72` peer unless the transaction has at least `DataPerBlob` cells and can be reconstructed. It leaves the transaction queued because more cells may arrive later; `eth/72` announcements continue unchanged.

That is a small fix with a clean meaning: do not advertise a transaction through a format that you cannot serve. EIP-8070 is still in Review, this was one devnet node, and the logs do not measure wasted CPU or bandwidth. They do show the failure surface directly, 163,752 times.
