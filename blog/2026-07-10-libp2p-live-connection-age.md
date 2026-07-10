---
slug: libp2p-live-connection-age
title: "Live libp2p connections were not one second old"
description: "Disconnect rows in Xatu's Tysm sample had a one-second median, but seven noon heartbeat snapshots put the median live connection age at 8h55m. The two tables measure opposite sides of the session lifecycle."
authors: aubury
tags: [ethereum, libp2p, xatu, data]
date: 2026-07-10
---

Two days ago I wrote that [most observed libp2p disconnect sessions lasted one second](/blog/libp2p-disconnect-one-second/). The number was right. The mental picture it invites is not.

Xatu has another table, `libp2p_synthetic_heartbeat`, that samples connections while they are still alive. In seven noon snapshots, its median live connection age was **8 hours 55 minutes**. The disconnect table's median was still **one second**.

<!-- truncate -->

<img src="/img/libp2p-live-connection-age.png" alt="Stacked bars comparing Xatu libp2p disconnect session lifetimes with live connection ages. Disconnect rows are 58.3% under ten seconds, while 84.4% of noon live-connection snapshots are at least one hour old." loading="eager" />

That is not a small denominator wobble. Across the seven complete UTC days from **2026-07-03 through 2026-07-09**, I counted **9,225,318** non-negative `libp2p_disconnected` rows. **58.28%** closed inside ten seconds and only **1.68%** lasted at least an hour.

For the live view, I did not sum the whole heartbeat table. It emits roughly one row per observer-peer pair per minute, so a seven-day raw-row average would repeatedly count the same live connection. I took the `12:00-12:01 UTC` slice from each day and kept the latest heartbeat per `(day, observer, remote peer)` instead. That left **101,433** pair-day snapshots from the same **41 Tysm observers**. Of those snapshots, **84.37%** were already at least an hour old and **35.41%** were older than a day.

Here is the live-side query. `connection_age_ms` is milliseconds, so the quantile is divided by 1,000 before I call it seconds.

```sql
SELECT
  count() AS live_snapshots,
  quantileExact(0.5)(age_ms) / 1000 AS p50_age_s,
  round(100 * countIf(age_ms < 10000) / count(), 2) AS under_10s_pct,
  round(100 * countIf(age_ms >= 3600000) / count(), 2) AS over_1h_pct,
  round(100 * countIf(age_ms >= 86400000) / count(), 2) AS over_24h_pct
FROM (
  SELECT
    toDate(event_date_time) AS day,
    meta_client_name,
    remote_peer_id_unique_key,
    argMax(connection_age_ms, event_date_time) AS age_ms
  FROM default.libp2p_synthetic_heartbeat FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-03 00:00:00')
    AND event_date_time <  toDateTime('2026-07-10 00:00:00')
    AND toHour(event_date_time) = 12
    AND toMinute(event_date_time) = 0
  GROUP BY day, meta_client_name, remote_peer_id_unique_key
);
```

The close-side query asks a different question. It measures completed session lifetime from `opened` to the disconnect event, then drops the **116** negative timestamp-dust rows before making the chart.

```sql
WITH dateDiff('second', opened, event_date_time) AS lifetime_s
SELECT
  count() AS disconnect_rows,
  quantileExact(0.5)(lifetime_s) AS p50_lifetime_s,
  round(100 * countIf(lifetime_s < 10) / count(), 2) AS under_10s_pct,
  round(100 * countIf(lifetime_s >= 3600) / count(), 2) AS over_1h_pct
FROM default.libp2p_disconnected FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-03 00:00:00')
  AND event_date_time <  toDateTime('2026-07-10 00:00:00')
  AND lifetime_s >= 0;
```

The heartbeat view is deliberately length-biased. A connection that survives for a day has many chances to be present at noon; a failed one-second attempt has almost none. That is exactly why it is useful here. Disconnect rows describe the **flow of session endings**, while a point-in-time heartbeat describes the **stock of connections still alive**.

The daily heartbeat medians moved around, from roughly **4.6 hours to 36 hours**, as observers and their peer sets restarted. The broad split did not disappear: every noon snapshot had more than **80%** of live pair rows older than an hour. This is not a mainnet node census, either. Remote peer keys repeat across observers, and all heartbeat rows in this window came from Tysm instrumentation.

So I would keep the one-second result, but put a fence around the noun. Most **disconnect rows** were tiny sessions. Most **live connection snapshots** were old. Counting the first one does not describe the shape of the second.
