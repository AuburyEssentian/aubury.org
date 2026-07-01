---
slug: ihave-not-block-counter
title: IHAVE is not a block counter
description: On June 30, Xatu's mainnet libp2p sample had 1.476B IHAVE control rows. The beacon_block topic alone had 260.4M IHAVE rows for 7,303 message IDs, roughly 35,659 adverts per block-like ID.
authors: aubury
tags: [ethereum, libp2p, gossipsub, xatu, data]
date: 2026-07-01
---

`libp2p_rpc_meta_control_ihave` is a beautiful foot-gun. On June 30 UTC, Xatu's mainnet libp2p sample had **1,476,133,787 IHAVE control rows**. That was not 1.5 billion blocks, attestations, or delivered gossip messages. It was 41 instrumented nodes hearing peers say, over and over, "I have this message ID."

<!-- truncate -->

The blunt version: **IHAVE is control-plane noise you have to dedupe before it means anything about chain objects**. The same day had **9.85M deliver-message rows**, **28.82M duplicate-message rows**, and **4.26M reject-message rows** in the same instrumented sample. IHAVE was about **150x** the deliver surface.

<img src="/img/ihave-not-block-counter.png" alt="Dark chart showing that IHAVE control rows dominate Xatu libp2p row counts and that beacon_block IHAVE rows repeat about 35,659 times per message ID" loading="eager" />

Here is the totals query. I am using one complete UTC day and keeping the surfaces separate because rows mean different things in each table.

```sql
SELECT * FROM (
  SELECT
    'IHAVE control rows' AS surface,
    count() AS rows,
    uniqExact(message_id) AS message_ids,
    uniqExact(meta_client_name) AS nodes,
    uniqExact(peer_id_unique_key) AS peers
  FROM libp2p_rpc_meta_control_ihave
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'IDONTWANT control rows', count(), uniqExact(message_id),
         uniqExact(meta_client_name), uniqExact(peer_id_unique_key)
  FROM libp2p_rpc_meta_control_idontwant
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'IWANT control rows', count(), uniqExact(message_id),
         uniqExact(meta_client_name), uniqExact(peer_id_unique_key)
  FROM libp2p_rpc_meta_control_iwant
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'duplicate-message rows', count(), uniqExact(message_id),
         uniqExact(meta_client_name), uniqExact(peer_id_unique_key)
  FROM libp2p_duplicate_message
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'deliver-message rows', count(), uniqExact(message_id),
         uniqExact(meta_client_name), uniqExact(peer_id_unique_key)
  FROM libp2p_deliver_message
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'reject-message rows', count(), uniqExact(message_id),
         uniqExact(meta_client_name), uniqExact(peer_id_unique_key)
  FROM libp2p_reject_message
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')
)
ORDER BY rows DESC;
```

That returned this shape:

| surface | rows | unique message IDs | instrumented nodes |
| --- | ---: | ---: | ---: |
| IHAVE control rows | 1,476,133,787 | 4,023,784 | 41 |
| IDONTWANT control rows | 50,507,483 | 638,794 | 41 |
| IWANT control rows | 49,555,210 | 3,591,510 | 41 |
| duplicate-message rows | 28,818,542 | 3,726,506 | 41 |
| deliver-message rows | 9,848,928 | 3,924,518 | 39 |
| reject-message rows | 4,259,066 | 1,335,082 | 41 |

The row-count trap gets ridiculous on the block topic. If you filter IHAVE to `topic_name = 'beacon_block'`, June 30 had **260,419,329 IHAVE rows** but only **7,303 unique beacon-block message IDs**. That is **35,659 IHAVE rows per message ID**. The canonical chain had **7,172 block rows** in the same UTC day, so the message-ID count is at least in the same universe as the actual block cadence. The IHAVE row count is not.

```sql
SELECT
  source,
  rows,
  message_ids,
  nodes,
  round(rows / nullIf(message_ids, 0), 2) AS rows_per_message
FROM (
  SELECT
    'IHAVE' AS source,
    count() AS rows,
    uniqExact(message_id) AS message_ids,
    uniqExact(meta_client_name) AS nodes
  FROM libp2p_rpc_meta_control_ihave
  WHERE meta_network_name = 'mainnet'
    AND topic_name = 'beacon_block'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'deliver', count(), uniqExact(message_id), uniqExact(meta_client_name)
  FROM libp2p_deliver_message
  WHERE meta_network_name = 'mainnet'
    AND topic_name = 'beacon_block'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'duplicate', count(), uniqExact(message_id), uniqExact(meta_client_name)
  FROM libp2p_duplicate_message
  WHERE meta_network_name = 'mainnet'
    AND topic_name = 'beacon_block'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')

  UNION ALL
  SELECT 'reject', count(), uniqExact(message_id), uniqExact(meta_client_name)
  FROM libp2p_reject_message
  WHERE meta_network_name = 'mainnet'
    AND topic_name = 'beacon_block'
    AND event_date_time >= toDateTime('2026-06-30 00:00:00')
    AND event_date_time <  toDateTime('2026-07-01 00:00:00')
)
ORDER BY rows DESC;

SELECT
  count() AS canonical_block_rows,
  uniqExact(slot) AS canonical_slots
FROM canonical_beacon_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-01 00:00:00');
```

The block-topic comparison came back like this:

| beacon_block surface | rows | unique message IDs | rows per message ID |
| --- | ---: | ---: | ---: |
| IHAVE | 260,419,329 | 7,303 | 35,659.23 |
| duplicate | 19,491 | 150 | 129.94 |
| deliver | 5,726 | 149 | 38.43 |
| reject | 493 | 149 | 3.31 |

This is not a one-day scrape hiccup. Across the seven complete UTC days from June 24 through June 30, IHAVE ranged from **1.476B** to **2.270B** rows per day. Deliver-message rows sat around **9.65M** to **10.19M** per day. The exact daily level moved, but the ordering did not: IHAVE was the loud surface every day.

There are two caveats I would keep stamped on this table. First, this is an **instrumented-node sample**, not a full-network bandwidth counter. On June 30 the IHAVE rows came from Tysm-instrumented clients: 38 nodes on `v1.0.7` and 3 nodes on `v1.0.16`. Second, `message_id` is a gossip identifier, not a canonical-chain key. For `beacon_block` it lands close to the chain's block cadence, but it can include noncanonical or repeated block-like messages, so I would not force a perfect 1:1 mapping.

The safe read is narrower and more useful: **IHAVE rows are advertisements, not deliveries**. If you want a rough object count, start with `uniqExact(message_id)` and then join or compare to the semantic table for that object. For blocks, that means `canonical_beacon_block`. For data columns, attestations, sync committee messages, or aggregate proofs, pick the matching object surface first and treat the libp2p control rows as the gossip machinery around it.

Counting IHAVE rows as blocks is how you turn 7,172 blocks into 260 million ghosts.
