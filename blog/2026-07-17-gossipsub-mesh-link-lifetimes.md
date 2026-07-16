---
slug: gossipsub-mesh-link-lifetimes
title: "Half of observed Gossipsub mesh links lasted under two seconds"
description: "In Xatu's Tysm sample, 18.20 million July 15 GRAFT-to-next-PRUNE pairs had a 1.824-second row-weighted median. Data-column subnets made up 69.2% of them."
authors: [aubury]
tags: [ethereum, libp2p, gossipsub, peerdas, xatu]
date: 2026-07-17
---

A libp2p connection can stay up while one of its Gossipsub mesh links is torn down two seconds after it is added. On July 15, the row-weighted median between a Tysm observer logging `GRAFT` and then `PRUNE` for the same peer and topic was **1.824 seconds**.

<!-- truncate -->

This is not the giant PRUNE control-row surface [I counted earlier](/blog/gossipsub-prune-row-multiplier/). Those `libp2p_rpc_meta_control_*` tables unpack controls carried inside RPCs. The top-level `libp2p_graft` and `libp2p_prune` tables come from go-libp2p-pubsub's [`RawTracer` callbacks](https://github.com/libp2p/go-libp2p-pubsub/blob/9eb5e8a9f7c26e3e177accedd35ce512b6f1b2b6/trace.go#L36-L39): one callback when a peer is grafted onto a topic mesh, another when it is pruned from that mesh.

That gives the rows a useful state-machine shape. I partitioned them by observer, peer key, fork digest, topic name and encoding, sorted them by event time, then looked at the immediate next event. A `GRAFT → PRUNE` pair is one uninterrupted observed mesh-membership interval for that exact observer-peer-topic key. Consecutive GRAFTs and open-ended rows stay out of the duration distribution instead of being forced into fake lifetimes.

```sql
WITH events AS (
  SELECT
    event_date_time,
    updated_date_time,
    meta_client_name,
    peer_id_unique_key,
    topic_fork_digest_value,
    topic_name,
    topic_encoding,
    'GRAFT' AS event
  FROM default.libp2p_graft FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-14 23:00:00')
    AND event_date_time <  toDateTime('2026-07-16 01:00:00')

  UNION ALL

  SELECT
    event_date_time,
    updated_date_time,
    meta_client_name,
    peer_id_unique_key,
    topic_fork_digest_value,
    topic_name,
    topic_encoding,
    'PRUNE' AS event
  FROM default.libp2p_prune FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-14 23:00:00')
    AND event_date_time <  toDateTime('2026-07-16 01:00:00')
), sequenced AS (
  SELECT
    *,
    leadInFrame(event, 1, '') OVER (
      PARTITION BY
        meta_client_name,
        peer_id_unique_key,
        topic_fork_digest_value,
        topic_name,
        topic_encoding
      ORDER BY event_date_time, updated_date_time, event
      ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING
    ) AS next_event,
    leadInFrame(
      event_date_time,
      1,
      toDateTime64('1970-01-01 00:00:00', 3)
    ) OVER (
      PARTITION BY
        meta_client_name,
        peer_id_unique_key,
        topic_fork_digest_value,
        topic_name,
        topic_encoding
      ORDER BY event_date_time, updated_date_time, event
      ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING
    ) AS next_time
  FROM events
)
SELECT
  count() AS graft_to_prune_pairs,
  uniqExact(meta_client_name) AS observers,
  uniqExact(peer_id_unique_key) AS peer_keys,
  quantileExact(0.50)(
    dateDiff('millisecond', event_date_time, next_time)
  ) AS p50_ms,
  quantileExact(0.95)(
    dateDiff('millisecond', event_date_time, next_time)
  ) AS p95_ms,
  countIf(
    dateDiff('millisecond', event_date_time, next_time) <= 2000
  ) AS within_2s
FROM sequenced
WHERE event = 'GRAFT'
  AND next_event = 'PRUNE'
  AND event_date_time >= toDateTime('2026-07-15 00:00:00')
  AND event_date_time <  toDateTime('2026-07-16 00:00:00');
```

July 15 had **18,454,267 GRAFT rows** and **19,280,512 PRUNE rows** across 32 Tysm observers. Of those GRAFTs, **18,197,894, or 98.61%, had PRUNE as the immediate next event** for the same key. Their p50 was 1.824 seconds, p95 was 41.022 seconds and p99 was 208.074 seconds. **53.04% ended within two seconds**, 75.51% within five, and 86.81% within ten.

<a href="/img/gossipsub-mesh-link-lifetimes.png?v=20260717" target="_blank" rel="noopener noreferrer">
  <img src="/img/gossipsub-mesh-link-lifetimes.png?v=20260717" alt="Distribution of 18.20 million Gossipsub GRAFT-to-next-PRUNE intervals on July 15. The row-weighted median was 1.824 seconds, 53.0 percent ended within two seconds, and noon-hour sample medians stayed near two seconds across fourteen days." loading="eager" />
</a>

<small><a href="/img/gossipsub-mesh-link-lifetimes.png?v=20260717" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a> These are row-weighted intervals in the instrumented sample, not an Ethereum-wide node statistic.</small>

The weighting caveat matters here. The 1.824-second p50 gives every paired event equal weight, so observers that emit more mesh changes count more. If I calculate a p50 inside each of the 32 observers first, the median observer lands at **7.552 seconds**; individual observer p50s range from 0.309 to 59.414 seconds. The short-link shape exists across the sample, but the loudest observers pull the combined median down.

Data-column subnets did most of the work. They supplied **12,592,840 pairs, or 69.20%** of the day's total, with a 1.882-second p50 and a 26.356-second p95. Attestation-subnet pairs were a much smaller 551,450 and lasted longer: 3.213 seconds at p50 and 119.149 seconds at p95. This is mesh activity per topic, so a protocol surface with many active data-column topics gets many chances to rearrange a peer link.

The shape was not one lucky hour. Across 14 complete UTC days, the two top-level tables held **287,498,395 GRAFT rows and 310,415,136 PRUNE rows**. In one fixed 12:00–13:00 UTC sample from each day, the paired p50 ranged from 1.614 to 4.063 seconds and sat below two seconds on 11 of 14 days. Observer coverage fell from 41 to 32 across the window, so I am using those samples as a repetition check, not a trend line.

I also checked whether this was mostly clients dropping and rejoining whole topics. It was not. On July 15, `libp2p_join` and `libp2p_leave` each had 56 rows, while the GRAFT and PRUNE tables had 37.73 million rows between them. That is roughly **336,918 mesh-link events per topic-subscription event**.

```sql
SELECT event, count() AS rows
FROM (
  SELECT event_date_time, 'JOIN' AS event
  FROM default.libp2p_join FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-15 00:00:00')
    AND event_date_time <  toDateTime('2026-07-16 00:00:00')

  UNION ALL
  SELECT event_date_time, 'LEAVE'
  FROM default.libp2p_leave FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-15 00:00:00')
    AND event_date_time <  toDateTime('2026-07-16 00:00:00')

  UNION ALL
  SELECT event_date_time, 'GRAFT'
  FROM default.libp2p_graft FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-15 00:00:00')
    AND event_date_time <  toDateTime('2026-07-16 00:00:00')

  UNION ALL
  SELECT event_date_time, 'PRUNE'
  FROM default.libp2p_prune FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-15 00:00:00')
    AND event_date_time <  toDateTime('2026-07-16 00:00:00')
)
GROUP BY event
ORDER BY event;
```

Current go-libp2p-pubsub code records these callbacks on several paths. It logs a GRAFT when an incoming request is accepted into the mesh, a PRUNE when the remote asks to leave it, and more GRAFT/PRUNE changes while the local [heartbeat maintains mesh size and scores](https://github.com/libp2p/go-libp2p-pubsub/blob/9eb5e8a9f7c26e3e177accedd35ce512b6f1b2b6/gossipsub.go#L1648-L1704). Xatu preserves the peer and topic but not the reason for each callback, and the exact pubsub dependency of the observed Tysm build is not in these tables. I cannot split two-second links into remote PRUNEs, score changes, heartbeat rebalancing or another path without inventing a cause.

The safe noun is **short-lived observer-peer-topic mesh links**. They are not two-second connections, disconnects, rejected messages, or peers leaving Ethereum. Gossipsub kept the connection surface underneath and rearranged the topic meshes on top of it, sometimes almost immediately.
