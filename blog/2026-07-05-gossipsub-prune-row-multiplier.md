---
slug: gossipsub-prune-row-multiplier
title: "Gossipsub PRUNE rows are not peer churn"
description: "Xatu's libp2p PRUNE control table printed 3.23B rows in one UTC day, but the observed peer set barely moved."
authors: [aubury]
tags: [ethereum, xatu, libp2p, gossipsub]
date: 2026-07-05
---

The libp2p control tables had one of those numbers that looks fake enough to be interesting: **3.23 billion PRUNE rows** on June 25, from the mainnet Gossipsub sample. If you read that as "three billion peers got pruned", the table is lying to you.

It is not a peer count. It is not a rejected-message count. It is a control-plane row surface, and on that day it expanded much faster than the observed peer set did.

<!-- truncate -->

<img src="/img/gossipsub-prune-row-multiplier.png" alt="Daily Gossipsub PRUNE rows spiked above 3 billion while observed peer IDs stayed around 14 thousand" loading="eager" />

Here is the daily query shape. The chart keeps June 20-24 as context, while the headline totals below use the complete June 25-July 3 spike window. I kept the public post aggregated and did not publish peer IDs or observer labels.

```sql
WITH g AS (
  SELECT
    toDate(event_date_time) AS day,
    count() AS graft_rows,
    uniqExact(peer_id_unique_key) AS graft_peers,
    uniqExact(meta_client_name) AS graft_nodes,
    uniqExact(meta_client_implementation) AS graft_impls,
    any(meta_client_implementation) AS graft_impl_sample,
    uniqExact(topic_name) AS graft_topics
  FROM default.libp2p_rpc_meta_control_graft
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-20 00:00:00')
    AND event_date_time <  toDateTime('2026-07-04 00:00:00')
  GROUP BY day
), p AS (
  SELECT
    toDate(event_date_time) AS day,
    count() AS prune_rows,
    uniqExact(peer_id_unique_key) AS prune_peers,
    uniqExact(meta_client_name) AS prune_nodes,
    uniqExact(meta_client_implementation) AS prune_impls,
    any(meta_client_implementation) AS prune_impl_sample,
    uniqExact(topic_name) AS prune_topics,
    countIf(graft_peer_id_unique_key IS NOT NULL) AS peer_exchange_rows
  FROM default.libp2p_rpc_meta_control_prune
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-20 00:00:00')
    AND event_date_time <  toDateTime('2026-07-04 00:00:00')
  GROUP BY day
)
SELECT
  coalesce(g.day, p.day) AS day,
  graft_rows,
  prune_rows,
  graft_peers,
  prune_peers,
  graft_nodes,
  prune_nodes,
  graft_impls,
  prune_impls,
  graft_impl_sample,
  prune_impl_sample,
  graft_topics,
  prune_topics,
  peer_exchange_rows,
  round(prune_rows / greatest(prune_peers, 1), 0) AS prune_rows_per_peer,
  round(graft_rows / greatest(prune_rows, 1), 4) AS graft_prune_ratio
FROM g
FULL OUTER JOIN p ON g.day = p.day
ORDER BY day;
```

The shape is ugly. From June 25 through July 3, `default.libp2p_rpc_meta_control_prune` had **11.65 billion** PRUNE rows. The matching GRAFT table had **557.76 million** rows. Both surfaces came from the same current sample shape: **one observing implementation**, Tysm, with up to **46 observing nodes** in the window. That matters. This is not a full-network peer census, and I would not use it as one.

But even inside that sample, the naive read breaks. The peak day had **3,230,084,267** PRUNE rows, **14,550** observed peer IDs, and **zero** rows with the peer-exchange field populated. The row count was about **222,000 PRUNE rows per observed peer ID** that day. The peer set rose a bit, but not by anything close to the same factor.

That last `peer_exchange_rows = 0` check is boring in the useful way. The table has a field for PRUNE peer-exchange entries, and it was empty for this whole June 25 to July 3 window. So the spike was not a hidden giant peer-exchange list showing up in the rows. It was ordinary control-row multiplication across topics, peers, and observer events.

The sanity check was to compare PRUNE rows to actual Gossipsub attestation messages. If PRUNE rows were a proxy for attestation volume, the message surface should move with it. It did not.

```sql
WITH selected AS (
  SELECT arrayJoin([
    'beacon_attestation_20',
    'beacon_attestation_38',
    'beacon_attestation_40',
    'beacon_attestation_44'
  ]) AS topic_name
), msg AS (
  SELECT
    toDate(slot_start_date_time) AS day,
    topic_name,
    count() AS attestation_msg_rows,
    uniqExact(message_id) AS attestation_msg_ids,
    uniqExact(meta_client_name) AS msg_nodes
  FROM default.libp2p_gossipsub_beacon_attestation
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-25 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-04 00:00:00')
    AND topic_name IN selected
  GROUP BY day, topic_name
), p AS (
  SELECT
    toDate(event_date_time) AS day,
    topic_name,
    count() AS prune_rows,
    uniqExact(meta_client_name) AS prune_nodes
  FROM default.libp2p_rpc_meta_control_prune
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-25 00:00:00')
    AND event_date_time <  toDateTime('2026-07-04 00:00:00')
    AND topic_name IN selected
  GROUP BY day, topic_name
)
SELECT
  msg.day,
  msg.topic_name,
  attestation_msg_rows,
  attestation_msg_ids,
  prune_rows,
  round(prune_rows / greatest(attestation_msg_rows, 1), 3) AS prune_per_message_row
FROM msg
LEFT JOIN p ON msg.day = p.day AND msg.topic_name = p.topic_name
ORDER BY msg.day, msg.topic_name;
```

`beacon_attestation_20` is a nice example because it is not subtle. On June 25 it had **3.11 million** unique attestation message IDs and **4.74 million** PRUNE rows. On June 30 it still had **3.11 million** unique attestation message IDs, but only **134,672** PRUNE rows. The message count was basically in the same band. The control table moved by roughly **35x**.

That is the trap. A Gossipsub PRUNE row is a mesh-control observation for a topic and peer entry in this instrumented surface. It is not a data object. It is not a peer leaving the network. It is not a clean bandwidth counter. Counting it raw gives you a control-plane row multiplier and then dares you to name it something more exciting.

I would still use these tables. They are useful for debugging mesh behavior, especially when you keep `topic_name`, observer implementation, and the row semantics in the denominator. I would just keep the nouns ugly: **PRUNE rows**, **observed peer IDs**, **Tysm-instrumented sample**.

Anything cleaner is probably wrong.
