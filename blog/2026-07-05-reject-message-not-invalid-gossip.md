---
slug: reject-message-not-invalid-gossip
title: "reject_message is mostly not invalid gossip"
description: "In seven complete UTC days, Xatu's libp2p_reject_message table had 31.0M rows. Only 247 were reason=validation failed."
authors: [aubury]
tags: [ethereum, xatu, libp2p, gossipsub]
date: 2026-07-05
---

`libp2p_reject_message` sounds accusatory. It looks like the table you would count if you wanted bad gossip, invalid messages, or peers doing something wrong.

That is almost exactly how to overread it. In the seven complete UTC days from Jun 28 through Jul 4, the table had **31,027,943** mainnet rows. Only **247** of them were `reason = 'validation failed'`.

<!-- truncate -->

<img src="/img/reject-message-not-invalid-gossip.png" alt="Log-scale chart of Xatu libp2p_reject_message rows by reason showing validation ignored at 28.88M rows, validation throttled at 2.14M rows, and validation failed at only 247 rows" loading="eager" />

Here is the query shape. I kept the window to complete UTC days, and I kept this aggregated: no node names, peer IDs, IPs, cities, ASNs, or observer labels.

```sql
SELECT
  reason,
  count() AS rows,
  uniqExact(message_id) AS ids,
  uniqExact(topic_name) AS topics,
  uniqExact(meta_client_name) AS nodes,
  round(rows / sum(rows) OVER () * 100, 4) AS row_pct,
  round(ids / sum(ids) OVER () * 100, 4) AS id_pct,
  round(rows / ids, 2) AS rows_per_id
FROM default.libp2p_reject_message
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-28 00:00:00')
  AND event_date_time <  toDateTime('2026-07-05 00:00:00')
GROUP BY reason
ORDER BY rows DESC;
```

The result is not subtle. `validation ignored` was **28,883,137 rows**, or **93.0875%** of the table. `validation throttled` was another **2,143,838 rows**, or **6.9094%**. The two scary-looking buckets were tiny: **721** `unexpected auth info` rows and **247** `validation failed` rows.

This is not just a wording quibble. In [`go-libp2p-pubsub`](https://github.com/libp2p/go-libp2p-pubsub/blob/master/tracer.go), the tracer has separate reject reasons for `validation throttled`, `validation failed`, and `validation ignored`. The validation path calls `RejectMessage(...)` for all of them. A message can land in this table because validation was ignored or throttled, not because the application validator decided the message was bad.

That explains why the raw row count is such a bad invalid-gossip counter. The seven-day sample was all Tysm-instrumented rows, with **46** observing nodes at the widest point. Inside that sample, actual `validation failed` stayed tiny every day: **27 to 62 rows per day**. The ignored share ranged from **88.85%** to **95.89%** depending on the day, while throttled rows filled most of the remainder.

The topic split makes the trap worse because the table looks busy in exactly the places Ethereum people care about. `beacon_aggregate_and_proof` alone had **19,534,204** reject-message rows, **62.96%** of the whole week. `sync_committee_contribution_and_proof` added **1,063,939** more. If you stop at topic and row count, you can accidentally tell a story about aggregate gossip being rejected at huge scale. The reason column says something much more boring.

I also checked the neighboring message surfaces so this did not rest entirely on one table's naming convention.

```sql
SELECT
  surface,
  count() AS rows,
  uniqExact(message_id) AS ids,
  uniqExact(topic_name) AS topics,
  uniqExact(meta_client_name) AS nodes,
  round(rows / ids, 2) AS rows_per_id
FROM (
  SELECT
    'deliver' AS surface,
    message_id,
    topic_name,
    meta_client_name
  FROM default.libp2p_deliver_message
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-28 00:00:00')
    AND event_date_time <  toDateTime('2026-07-05 00:00:00')

  UNION ALL

  SELECT
    'duplicate' AS surface,
    message_id,
    topic_name,
    meta_client_name
  FROM default.libp2p_duplicate_message
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-28 00:00:00')
    AND event_date_time <  toDateTime('2026-07-05 00:00:00')

  UNION ALL

  SELECT
    concat('reject:', reason) AS surface,
    message_id,
    topic_name,
    meta_client_name
  FROM default.libp2p_reject_message
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-28 00:00:00')
    AND event_date_time <  toDateTime('2026-07-05 00:00:00')
)
GROUP BY surface
ORDER BY rows DESC;
```

That comparison had **207.8M** duplicate-message rows, **68.4M** delivered-message rows, **28.9M** `reject:validation ignored` rows, and **2.1M** `reject:validation throttled` rows. Actual `reject:validation failed` was still **247** rows. The reject table is part of a gossip-observation surface, not a clean list of invalid Ethereum objects.

So the safe noun is ugly: **reject-message rows by tracer reason**. If the question is "how many bad gossip messages did this sample see?", the raw table name is not enough. Start with `reason`, keep the observer sample in the denominator, and only call the `validation failed` bucket failed validation.

Everything else is a footgun with a good column name.
