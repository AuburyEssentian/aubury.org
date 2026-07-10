---
slug: libp2p-live-stale-heads
title: "Some live peers were weeks behind Ethereum's head"
description: "Fourteen noon snapshots of Xatu's Tysm sample found a persistent live tail more than one day behind head. On Jul 10, 205 observer-peer pairs were in that tail; the median lag was 16.2 days."
authors: aubury
tags: [ethereum, libp2p, xatu, consensus]
date: 2026-07-11
---

[Yesterday's heartbeat post](/blog/libp2p-live-connection-age/) left an uncomfortable question. The live connections were old, but were the peers on the other end actually keeping up? Mostly, yes.

At 12:00 UTC on July 10, **93.76%** of matched observer-peer pairs reported the same head slot. Another **205 live pairs**, covering **145 remote peer keys**, answered from more than 7,200 slots behind. The median lag inside that tail was **116,439 slots**, or **16.2 days**.

<!-- truncate -->

<img src="/img/libp2p-live-stale-heads.png" alt="Log-scale bar chart of live outbound Status v2 replies by remote head lag. Most of the 14,676 observer-peer pairs reported the same head, while 205 pairs covering 145 remote peer keys were more than one day behind." loading="eager" />

The table is `default.libp2p_handle_status`. For an outbound Status v2 exchange, the request carries the observer's view and the response carries the remote peer's view. The [consensus p2p spec](https://github.com/ethereum/consensus-specs/blob/master/specs/phase0/p2p-interface.md#status-v1) defines `head_slot` as the slot of the current head block; [Status v2](https://github.com/ethereum/consensus-specs/blob/master/specs/fulu/p2p-interface.md#status-v2) adds `earliest_available_slot` but keeps the same head fields.

So the ugly honest metric is just `request_head_slot - response_head_slot`. Mainnet has 12-second slots, which makes **7,200 slots one day**. I took one minute at noon each day, kept the latest outbound reply per `(day, observer, remote peer)`, and then matched those pairs to `libp2p_synthetic_heartbeat` so a status reply only counted when the connection also appeared in the live heartbeat slice.

```sql
-- Fetch the status side first.
SELECT
  toDate(event_date_time) AS day,
  meta_client_name,
  peer_id_unique_key,
  argMax(request_head_slot,
         tuple(event_date_time, updated_date_time)) AS local_head,
  argMax(response_head_slot,
         tuple(event_date_time, updated_date_time)) AS remote_head,
  argMax(request_finalized_epoch,
         tuple(event_date_time, updated_date_time)) AS local_finalized,
  argMax(response_finalized_epoch,
         tuple(event_date_time, updated_date_time)) AS remote_finalized
FROM default.libp2p_handle_status FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-27 12:00:00')
  AND event_date_time <  toDateTime('2026-07-11 12:01:00')
  AND toHour(event_date_time) = 12
  AND toMinute(event_date_time) = 0
  AND protocol = '/eth2/beacon_chain/req/status/2/ssz_snappy'
  AND direction = 'outbound'
  AND error IS NULL
GROUP BY day, meta_client_name, peer_id_unique_key;

-- Fetch live connections separately, then join locally on
-- (day, meta_client_name, peer_id_unique_key).
SELECT
  toDate(event_date_time) AS day,
  meta_client_name,
  remote_peer_id_unique_key AS peer_id_unique_key,
  argMax(connection_age_ms,
         tuple(event_date_time, updated_date_time)) AS connection_age_ms
FROM default.libp2p_synthetic_heartbeat FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-27 12:00:00')
  AND event_date_time <  toDateTime('2026-07-11 12:01:00')
  AND toHour(event_date_time) = 12
  AND toMinute(event_date_time) = 0
GROUP BY day, meta_client_name, remote_peer_id_unique_key;
```

I kept that join local because a large distributed raw-table join changed the matched count between runs. The separate queries produced **216,530 status pair-day rows** and **228,139 heartbeat pair-day rows** across the 14 slices; **98.09%** of the status rows matched a heartbeat row. The Jul 10 matched slice held **14,676 live pair snapshots** covering **8,217 remote peer keys**.

The stale tail was not a one-day accident. In every noon slice from June 27 through July 10, between **1.09% and 3.02%** of matched live pairs replied from more than one day behind head. That was **184 to 362 pair snapshots** per day after the local heartbeat match.

The Jul 10 tail was properly stale, not just on the wrong side of an arbitrary threshold. Its median remote head lag was **116,439 slots**, and all **205** pairs were also more than four finalized epochs behind the observer. **24 replies reported head slot 0**, the genesis slot. Yet the median live connection age for this tail was **21.1 hours**, so these were not just failed one-second dials caught on the way out.

Raw row counts are especially bad here. From July 3 through July 9, `libp2p_handle_status` had **199,119,216 outbound Status v2 rows**, while `libp2p_connected` had **9,227,979 connection-open rows** from the same 41-observer surface. That is a **21.58x** row multiplier. The spec requires a status request when a client connects and allows another request when it needs to learn a peer's newer head; this instrumented surface was plainly not one row per connection.

There is a fence around the finding. These are observer-peer connection pairs in a Tysm-instrumented sample, not validators, not unique Ethereum nodes, and not a client-share estimate. A remote peer key can appear under more than one observer.

They were not database fossils either. The heartbeat table saw the same connections alive, and some of those live connections were still exchanging status with peers days, months, or all the way back at genesis behind head. `count()` hides that shape. A one-minute latest-per-pair snapshot does not.
