---
slug: gossipsub-prune-drop-storm
title: "One observer-peer pair logged 80,000 PRUNE‑heavy drops in a minute"
description: "One Tysm observer-peer pair logged 80,749 outbound Gossipsub DropRPC events in one minute. Almost every parent carried PRUNE controls drawn from just five topic shapes."
authors: [aubury]
tags: [ethereum, libp2p, gossipsub, data, xatu]
date: 2026-07-13
---

At 09:15 UTC on July 11, one Tysm observer-peer pair logged **80,749 outbound Gossipsub `DropRPC` events in 60 seconds**. PRUNE controls appeared in **80,164** of those parent RPCs, producing 146,218 child rows across five `(fork digest, topic name, encoding)` tuples and no peer-exchange entries. Those child rows were not 146,218 peers leaving Ethereum.

<!-- truncate -->

Upstream go-libp2p-pubsub defines [`DropRPC`](https://github.com/libp2p/go-libp2p-pubsub/blob/9eb5e8a9f7c26e3e177accedd35ce512b6f1b2b6/trace.go#L55) as an outbound RPC that was dropped, "typically because of a queue full." The trace event does not carry the reason, and the observed Tysm build's pubsub dependency is not recorded in this table. Xatu therefore tells me which observer-peer pair emitted the event and what the parent RPC contained, but not why that send path rejected it.

```python
peak = clickhouse.query("clickhouse-raw", """
SELECT
  meta_client_name AS observer,
  peer_id_unique_key AS peer,
  any(meta_client_implementation) AS implementation,
  count() AS drops
FROM default.libp2p_drop_rpc FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-11 09:15:00')
  AND event_date_time <  toDateTime('2026-07-11 09:16:00')
GROUP BY observer, peer
ORDER BY drops DESC
LIMIT 1
""").iloc[0]

prune = clickhouse.query("clickhouse-raw", """
SELECT
  count() AS prune_rows,
  uniqExact(rpc_meta_unique_key) AS parent_rpcs,
  uniqExact(tuple(
    topic_fork_digest_value,
    topic_name,
    topic_encoding
  )) AS topic_shapes,
  countIf(graft_peer_id_unique_key IS NOT NULL) AS peer_exchange_rows
FROM default.libp2p_rpc_meta_control_prune FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-11 09:15:00')
  AND event_date_time <  toDateTime('2026-07-11 09:16:00')
  AND meta_client_name = {observer:String}
  AND peer_id_unique_key = {peer:Int64}
  AND rpc_meta_unique_key GLOBAL IN (
    SELECT unique_key
    FROM default.libp2p_drop_rpc FINAL
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-07-11 09:15:00')
      AND event_date_time <  toDateTime('2026-07-11 09:16:00')
      AND meta_client_name = {observer:String}
      AND peer_id_unique_key = {peer:Int64}
  )
""", parameters={
  "observer": peak.observer,
  "peer": int(peak.peer),
})
```

That returned **146,218 PRUNE child rows**, **80,164 distinct dropped parent RPCs**, **five topic shapes**, and **zero peer-exchange rows**. There were 80,749 dropped parents in the minute, so 99.3% carried PRUNE.

<a href="/img/gossipsub-prune-drop-storm.png" target="_blank" rel="noopener noreferrer">
  <img src="/img/gossipsub-prune-drop-storm.png" alt="Minute-by-minute timeline of dropped outbound Gossipsub RPC events on July 11, highlighting PRUNE-heavy observer-peer bursts and an 80,749-event spike at 09:15 UTC." loading="eager" />
</a>

<small><a href="/img/gossipsub-prune-drop-storm.png" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a></small>

I repeated that parent-key gate for the ten largest observer-peer burst minutes. Across them, **670,457 parent RPCs were dropped** and **651,094, or 97.1%, carried PRUNE controls**. Nine of those minutes were above 98.5% PRUNE-carrying parents; the remaining minute was 76.8%.

Current upstream code offers a mechanism that fits this shape, although it does not prove the observed rows were retries. [`doDropRPC`](https://github.com/libp2p/go-libp2p-pubsub/blob/9eb5e8a9f7c26e3e177accedd35ce512b6f1b2b6/gossipsub.go#L1595-L1613) passes dropped control entries back to the pending-control path with `gs.pushControl(p, ctl)`. A later RPC can piggyback GRAFT or PRUNE controls that remain relevant. The Xatu rows have neither a drop reason nor a retry identity, so five repeated topic shapes are consistent with requeued PRUNE controls, not a reconstructed retry chain.

July 11 had **2,243,791 `libp2p_drop_rpc` rows and 2,243,791 unique event keys**, spread across 116 observer-peer pairs and four Tysm observers. Those observers also logged **283,452,336 `SendRPC` events** across all peers. Drops were **0.785%** of the combined `DropRPC` + `SendRPC` tracer surface for those four observers; `SendRPC` means the local queue accepted the RPC, not that the remote peer received it.

The 116 affected pairs logged **2,243,791 drops against 307,610 `SendRPC` events**, an **87.94% pair-cohort DropRPC share**. Forty-seven pairs were above 50%, 32 were above 90%, and one pair alone contributed 832,220 drops, or 37.09% of the day's total. The top 20 pairs contributed 88.43%.

I built that denominator from separate parent tables and joined locally on `(meta_client_name, peer_id_unique_key)`. This keeps PRUNE child rows out of the parent-event denominator and avoids a distributed join over several hundred million `SendRPC` rows:

```sql
-- Drop parents, one row per traced outbound failure
SELECT
  meta_client_name,
  peer_id_unique_key,
  count() AS drops,
  uniqExact(unique_key) AS unique_drop_events
FROM default.libp2p_drop_rpc FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-11 00:00:00')
  AND event_date_time <  toDateTime('2026-07-12 00:00:00')
GROUP BY meta_client_name, peer_id_unique_key;

-- SendRPC parent events for the 116 exact pairs, merged in Python
SELECT
  meta_client_name,
  peer_id_unique_key,
  count() AS sent
FROM default.libp2p_send_rpc FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-11 00:00:00')
  AND event_date_time <  toDateTime('2026-07-12 00:00:00')
  AND (meta_client_name, peer_id_unique_key) IN (<affected pairs>)
GROUP BY meta_client_name, peer_id_unique_key;

-- SendRPC events across all peers of observers that logged a drop
SELECT count() AS sent
FROM default.libp2p_send_rpc FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-11 00:00:00')
  AND event_date_time <  toDateTime('2026-07-12 00:00:00')
  AND meta_client_name GLOBAL IN (
    SELECT meta_client_name
    FROM default.libp2p_drop_rpc FINAL
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-07-11 00:00:00')
      AND event_date_time <  toDateTime('2026-07-12 00:00:00')
    GROUP BY meta_client_name
  );
```

I widened the same parent scan to 14 complete UTC days, June 28 through July 11:

```sql
SELECT
  toDate(event_date_time) AS day,
  meta_client_name,
  peer_id_unique_key,
  count() AS drops,
  uniqExact(unique_key) AS unique_drop_events
FROM default.libp2p_drop_rpc FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-28 00:00:00')
  AND event_date_time <  toDateTime('2026-07-12 00:00:00')
GROUP BY day, meta_client_name, peer_id_unique_key;
```

The result held **36,022,114 unique DropRPC events** across 739 distinct observer-peer pairs. Every day was concentrated: the top 20 pairs carried between **81.76% and 98.94%** of daily drops. Observer coverage changed sharply across the window, so those raw day totals are not a trend line and should not be turned into a Tysm health score.

This is not an invalid-gossip counter or evidence that hundreds of peers left the network. `DropRPC` is local outbound send-path telemetry, while PRUNE is a topic-mesh control message. Across these four observers, the aggregate DropRPC share was below 1%, while the 116 affected pairs had an 87.94% DropRPC share and 32 pairs were above 90%. The five-shape concentration is consistent with requeued PRUNE controls, but it is not a measure of remote receipt, invalid gossip, disconnects, peer churn, or network-wide health.
