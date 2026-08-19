---
slug: libp2p-subscription-empty-peer
title: "One subscription event, two rows, one empty peer ID"
description: "Across 15 complete mainnet days, 96.38% of Xatu libp2p RPC subscription rows sat in exact two-row pairs. One copy kept the peer key; the other hashed an empty peer ID."
authors: aubury
tags: [ethereum, libp2p, peerdas, xatu, data-quality]
date: 2026-08-20
---

A fresh [Gloas spec change](https://github.com/ethereum/consensus-specs/pull/5549) sent me looking for an ugly sanity check: do observed peer subscriptions line up with custody metadata? The obvious raw table answered before I had joined anything. One stored `peer_id_unique_key` owned almost exactly half the rows across every observer. Gloas is not live on mainnet; it just gave me a reason to inspect current mainnet capture.

That peer does not exist.

<!-- truncate -->

The key was `-1899444555419234845`. It had no row in `libp2p_peer`, no synthetic heartbeat, and no client label. It was just the SeaHash of the string `mainnet`, which is what Xatu stores when `peerID` is empty and the route still computes `SeaHashInt64(peerID + networkName)`.

The missing identity was annoying. The suspicious part was how tidy it looked: 49.92% of all subscription rows had that key, and the share sat near 50% on all 15 complete UTC days from August 4 through August 18. Across the 34 observers, it ranged from 49.27% to 50.00%.

![Daily raw libp2p subscription rows sit at roughly twice the event-shape count; 96.38% of rows form exact pairs and half carry the empty-peer-ID sentinel.](/img/libp2p-subscription-empty-peer.png)

I collapsed only the fields that should describe the subscription event itself: millisecond event time, observer, fork digest, topic, encoding, subscribe flag, and control index. I deliberately left out the peer key, parent RPC key, and child key because those were the fields disagreeing between copies.

The query below uses literal complete UTC days. `FINAL` removes only revisions at the table's own key.

```sql
SELECT
  sum(group_rows) AS raw_rows,
  count() AS event_shapes,
  round(raw_rows / event_shapes, 4) AS rows_per_shape,
  countIf(
    group_rows = 2
    AND empty_rows = 1
    AND identified_rows = 1
  ) AS exact_pair_groups,
  exact_pair_groups * 2 AS exact_pair_rows,
  round(100 * exact_pair_rows / raw_rows, 4) AS exact_pair_row_pct,
  sum(empty_rows) AS empty_id_rows,
  round(100 * empty_id_rows / raw_rows, 4) AS empty_id_pct
FROM (
  SELECT
    event_date_time,
    meta_client_name,
    topic_fork_digest_value,
    topic_name,
    topic_encoding,
    subscribe,
    control_index,
    count() AS group_rows,
    countIf(peer_id_unique_key = -1899444555419234845) AS empty_rows,
    countIf(peer_id_unique_key != -1899444555419234845) AS identified_rows
  FROM libp2p_rpc_meta_subscription FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-08-04 00:00:00')
    AND event_date_time <  toDateTime('2026-08-19 00:00:00')
  GROUP BY
    event_date_time,
    meta_client_name,
    topic_fork_digest_value,
    topic_name,
    topic_encoding,
    subscribe,
    control_index
)
```

| Measure | Result |
|---|---:|
| Raw child rows | 9,091,365 |
| Event shapes | 4,512,135 |
| Rows per shape | 2.0149 |
| Rows in exact two-row pairs | 8,762,148 (96.38%) |
| Empty-ID rows | 4,538,201 (49.92%) |

An exact pair here means the two rows agree on every grouped field, down to the millisecond, while one has a real peer key and one has the empty-ID key. The paired rows do not share a parent RPC key or child key. Both therefore survive the `ReplacingMergeTree` key and remain visible under `FINAL`.

This is not a fuzzy daily correlation. On August 18, 96.16% of rows were in exact pairs and exactly 50.00% carried the empty-ID key. The daily paired share stayed between 95.03% and 97.13% for the whole window. Accidental collisions between separate peers would have to reproduce the same observer, timestamp, topic fields, boolean, and control-array position, then do it millions of times with the same one-real/one-empty split.

The [current Xatu route](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/clickhouse/route/libp2p/libp2p_rpc_meta_subscription.go) makes the sentinel straightforward. It reads the wrapped peer ID and passes it to [`computePeerIDUniqueKey`](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/clickhouse/route/libp2p/enrichment.go):

```go
peerID := wrappedStringValue(payload.GetPeerId())
networkName := event.GetMeta().GetClient().GetEthereum().GetNetwork().GetName()
b.PeerIDUniqueKey.Append(computePeerIDUniqueKey(peerID, networkName))
```

That helper hashes `peerID + networkName`. Xatu's [SeaHash implementation](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/clickhouse/route/seahash.go) returns `-1899444555419234845` for `mainnet`, exactly the stored value. A lookup of that key in `libp2p_peer FINAL` returned zero rows, as did a 15-day lookup in `libp2p_synthetic_heartbeat`.

The data proves that paired copies enter this capture path. It does not prove where the duplication starts. The tracer, transport, and collector are still separate suspects, and the table does not retain enough provenance to pick one honestly. Different root IDs only tell us why the database keeps both copies.

So the safe read is narrow. `count()` is not a subscription-event count here, and the empty-ID hash is not one extremely busy peer. For a known-peer subset, collapse the event shape and keep the identified copy; unmatched and larger groups need separate treatment. Do not turn this table into a custody census, a client-share chart, or a peer leaderboard until the capture path is fixed or the identity loss is made explicit.

The Gloas `custody_columns` change is real, but this table cannot answer the question that sent me here. For now, the busiest peer in the result is still an empty string wearing a very convincing integer.
