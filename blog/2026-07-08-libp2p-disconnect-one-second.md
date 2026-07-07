---
slug: libp2p-disconnect-one-second
title: "Most libp2p disconnects lasted one second"
description: "Across seven complete UTC days, Xatu's mainnet libp2p_disconnected table had 8.87M disconnect rows over 23.8k remote peer keys. The median observed session lifetime was one second."
authors: [aubury]
tags: [ethereum, libp2p, xatu, data]
date: 2026-07-08
---

`libp2p_disconnected` sounds like a peer-churn table. I would not use it that way.

Across the latest seven complete UTC days, Xatu recorded **8,874,848** mainnet disconnect rows from **41** observer labels. Those rows covered **23,820** remote peer keys, but the median observed session lifetime was only **one second**. **57.55%** of the rows ended inside ten seconds.

<!-- truncate -->

<img src="/img/libp2p-disconnect-one-second.png" alt="Dark horizontal bar chart of Xatu mainnet libp2p disconnect session lifetimes from June 30 through July 6 2026. It shows 45.0 percent under one second, 12.5 percent from one to nine seconds, and only 1.44 percent over one hour." loading="eager" />

The table is still useful. It is just useful for a narrower thing than the name suggests: observer-peer connection sessions. A row does not mean a peer left Ethereum. It means one instrumented libp2p client observed one connection close with one remote peer.

Here's the query I used for the headline numbers. I kept the grain explicit: raw rows, deduped connection edges by `(observer, remote peer, direction, opened)`, remote peer keys, observer-peer pairs, and lifetime buckets from `opened` to the disconnect event time.

```sql
-- clickhouse-raw, mainnet libp2p connection-session grain
WITH
  conn AS (
    SELECT
      count() AS connected_rows,
      uniqExact(tuple(meta_client_name, remote_peer_id_unique_key, direction, opened)) AS connected_edges,
      uniqExact(remote_peer_id_unique_key) AS connected_peers,
      uniqExact(tuple(meta_client_name, remote_peer_id_unique_key)) AS connected_observer_peer_pairs,
      uniqExact(meta_client_name) AS connected_observers
    FROM default.libp2p_connected
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-06-30 00:00:00')
      AND event_date_time <  toDateTime('2026-07-07 00:00:00')
  ),
  disc AS (
    SELECT
      count() AS disconnected_rows,
      uniqExact(tuple(meta_client_name, remote_peer_id_unique_key, direction, opened)) AS disconnected_edges,
      uniqExact(remote_peer_id_unique_key) AS disconnected_peers,
      uniqExact(tuple(meta_client_name, remote_peer_id_unique_key)) AS disconnected_observer_peer_pairs,
      uniqExact(meta_client_name) AS disconnected_observers,
      countIf(dateDiff('second', opened, event_date_time) < 10) AS under_10s,
      countIf(dateDiff('second', opened, event_date_time) < 60) AS under_60s,
      countIf(dateDiff('second', opened, event_date_time) >= 3600) AS over_1h,
      countIf(dateDiff('second', opened, event_date_time) < 0) AS negative_lifetime,
      quantile(0.5)(dateDiff('second', opened, event_date_time)) AS p50_lifetime_s,
      quantile(0.9)(dateDiff('second', opened, event_date_time)) AS p90_lifetime_s,
      quantile(0.95)(dateDiff('second', opened, event_date_time)) AS p95_lifetime_s,
      quantile(0.99)(dateDiff('second', opened, event_date_time)) AS p99_lifetime_s
    FROM default.libp2p_disconnected
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-06-30 00:00:00')
      AND event_date_time <  toDateTime('2026-07-07 00:00:00')
  )
SELECT
  connected_rows,
  connected_edges,
  connected_peers,
  disconnected_rows,
  disconnected_edges,
  disconnected_peers,
  round(disconnected_rows / connected_rows, 4) AS disconnect_connect_row_ratio,
  round(disconnected_edges / connected_edges, 4) AS disconnect_connect_edge_ratio,
  round(disconnected_rows / disconnected_peers, 1) AS disconnect_rows_per_peer,
  round(disconnected_rows / disconnected_observer_peer_pairs, 1) AS disconnect_rows_per_observer_peer_pair,
  round(100 * under_10s / disconnected_rows, 2) AS under_10s_pct,
  round(100 * under_60s / disconnected_rows, 2) AS under_60s_pct,
  round(100 * over_1h / disconnected_rows, 2) AS over_1h_pct,
  negative_lifetime,
  p50_lifetime_s,
  p90_lifetime_s,
  p95_lifetime_s,
  p99_lifetime_s
FROM conn, disc;
```

The connect/disconnect sanity check matters. If the disconnect table were only catching the easy cases, the one-second result would be suspect. It wasn't: the same window had **8,877,432** connected rows and **8,874,848** disconnected rows, and the deduped edge counts matched at a **0.9997** ratio. The table was not missing half the lifecycle. The lifecycle itself was tiny.

The distribution is ugly in the way real network telemetry is ugly. About **4.00M** disconnect rows had a whole-second lifetime of `0`, meaning they closed before crossing the next integer second boundary. Another **1.11M** landed in the `1-9s` bucket. By one minute, **74.77%** of all disconnect rows were already gone. Only **127,900** rows, **1.44%** of the week, represented sessions that lasted more than an hour.

I also checked this by day because a one-day burst would make a bad post. The shape was stable. Each complete UTC day from Jun 30 through Jul 5 had about **1.2M-1.3M** disconnect rows, roughly **14.8k-15.7k** remote peer keys, a median lifetime of **one second**, and **56.87%-58.06%** of rows under ten seconds. Jul 6 had more rows, **1.44M**, and a fatter long tail, but the median was still one second and **57.97%** of rows still ended inside ten seconds.

So the trap is not just "raw rows are duplicated." It is sharper than that. A single remote peer key can appear hundreds of times because the row grain is session lifecycle, and the session lifecycle is mostly short-lived connection attempts or tiny completed sessions. In this sample, the disconnect table averaged **372.6 disconnect rows per remote peer key** over the week, or **40.9 rows per observer-peer pair**.

That does not mean 23.8k Ethereum nodes. It does not mean 8.87M peers churned out of the network. It also does not mean the clients named in `remote_agent_implementation` have those shares on mainnet; those are remote self-reported/libp2p-observed agent strings inside one instrumented sample. The safe public noun is boring and precise: **disconnect rows** or **observed connection sessions**.

There were **144** negative lifetime rows, which I left out of the chart and kept in the query result. At this scale, that is rounding dust, probably timestamp granularity or edge ordering around `opened` versus the event timestamp. It is still a useful reminder not to over-polish the table into something it is not.

I keep finding the same pattern in these libp2p surfaces: the table names sound like network facts, but the rows are instrumentation facts. IHAVE rows are advertisements. PRUNE rows are control messages. These disconnect rows are connection-session closes. Count them, but count the thing they actually are.