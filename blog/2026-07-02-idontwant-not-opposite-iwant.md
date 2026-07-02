---
slug: idontwant-not-opposite-iwant
title: IDONTWANT is not the opposite of IWANT
description: On July 1, Xatu's mainnet libp2p sample had 48.8M IDONTWANT rows, almost as many as IWANT. After deduping, those rows covered only 675,563 message IDs, and most did not map back to a same-window topic surface.
authors: aubury
tags: [ethereum, libp2p, gossipsub, xatu, data]
date: 2026-07-02
---

`IDONTWANT` sounds like the clean negative image of `IWANT`: one peer asks for a message, another says please do not send it. The row counts even make that story tempting. On July 1 UTC, Xatu's mainnet libp2p sample had **56.2M IWANT rows** and **48.8M IDONTWANT rows**.

That neat story breaks as soon as you dedupe the message IDs.

<!-- truncate -->

<img src="/img/idontwant-not-opposite-iwant.png" alt="Dark chart showing IWANT and IDONTWANT row counts, unique message IDs, and topic mapping rates" loading="eager" />

I looked at this because the [IHAVE foot-gun](/blog/ihave-not-block-counter/) left one loose thread. IHAVE rows were obviously advertisements, not objects, but IDONTWANT sat weirdly close to IWANT in the same raw table family. If those two were mirror-image request/cancel surfaces, their unique message-ID sets should at least look like cousins.

They do not. IWANT covered **3,700,812** unique message IDs on July 1. IDONTWANT covered **675,563**. The median IWANT message ID appeared **6** times in the raw rows; the median IDONTWANT message ID appeared **62** times. Same rough row magnitude, totally different denominator.

Here is the exact query for that first check. It groups by `message_id` first, then aggregates the grouped rows, because the raw control rows are the thing that lies to you here.

```sql
SELECT
  control,
  sum(rows_for_id) AS rows,
  count() AS message_ids,
  round(rows / message_ids, 2) AS rows_per_message_id,
  quantileExact(0.50)(rows_for_id) AS p50_rows_per_id,
  quantileExact(0.90)(rows_for_id) AS p90_rows_per_id,
  quantileExact(0.99)(rows_for_id) AS p99_rows_per_id,
  max(rows_for_id) AS max_rows_per_id
FROM (
  SELECT
    'IWANT' AS control,
    message_id,
    count() AS rows_for_id
  FROM libp2p_rpc_meta_control_iwant
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-01 00:00:00')
    AND event_date_time <  toDateTime('2026-07-02 00:00:00')
  GROUP BY message_id

  UNION ALL

  SELECT
    'IDONTWANT' AS control,
    message_id,
    count() AS rows_for_id
  FROM libp2p_rpc_meta_control_idontwant
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-01 00:00:00')
    AND event_date_time <  toDateTime('2026-07-02 00:00:00')
  GROUP BY message_id
)
GROUP BY control
ORDER BY rows DESC;
```

That returned:

| control | rows | unique message IDs | avg rows per ID | p50 rows per ID | p90 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IWANT | 56,195,419 | 3,700,812 | 15.18 | 6 | 22 | 158 | 7,698 |
| IDONTWANT | 48,779,664 | 675,563 | 72.21 | 62 | 126 | 390 | 1,998 |

The protocol shape explains why this is not a simple request-versus-reject table. Gossipsub v1.2 introduced [`IDONTWANT`](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.2.md) so a node can tell mesh peers it already received a message and does not need duplicate copies. The same spec also allows it to cancel a pending IWANT if the node asked one peer for a message and then received the message from somewhere else.

That is an important difference. A rejected-message table has a topic, a validation result, and a payload that showed up. An IDONTWANT row is control-plane gossip about a `message_id`. In Xatu's raw table it does not carry `topic_name`, so you have to join it to another surface before you can even say what kind of thing the ID was probably about.

The join is where the trap gets sharper. I mapped each control table to `libp2p_rpc_meta_message`, the raw RPC payload-message surface for the same UTC day. IWANT behaved like a normal request surface: **99.97% of IWANT rows** mapped to a payload message ID. IDONTWANT did not: only **4.26% of IDONTWANT rows** mapped that way.

```sql
SELECT
  control,
  control_message_ids,
  total_control_rows,
  mapped_message_ids,
  mapped_control_rows,
  round(100 * mapped_message_ids / control_message_ids, 2) AS pct_ids_mapped,
  round(100 * mapped_control_rows / total_control_rows, 2) AS pct_rows_mapped
FROM (
  SELECT
    control,
    count() AS control_message_ids,
    sum(rows_for_id) AS total_control_rows,
    countIf(topic_name != '') AS mapped_message_ids,
    sumIf(rows_for_id, topic_name != '') AS mapped_control_rows
  FROM (
    SELECT
      'IWANT' AS control,
      message_id,
      count() AS rows_for_id
    FROM libp2p_rpc_meta_control_iwant
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-07-01 00:00:00')
      AND event_date_time <  toDateTime('2026-07-02 00:00:00')
    GROUP BY message_id

    UNION ALL

    SELECT
      'IDONTWANT' AS control,
      message_id,
      count() AS rows_for_id
    FROM libp2p_rpc_meta_control_idontwant
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-07-01 00:00:00')
      AND event_date_time <  toDateTime('2026-07-02 00:00:00')
    GROUP BY message_id
  ) AS c
  GLOBAL ANY LEFT JOIN (
    SELECT
      message_id,
      any(topic_name) AS topic_name
    FROM libp2p_rpc_meta_message
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-07-01 00:00:00')
      AND event_date_time <  toDateTime('2026-07-02 00:00:00')
    GROUP BY message_id
  ) AS m USING message_id
  GROUP BY control
)
ORDER BY total_control_rows DESC;
```

The mapping result was lopsided enough that I reran it against IHAVE, because maybe IDONTWANT was just referring to advertised IDs that never became payload messages locally. IWANT mapped to IHAVE at **100%**. IDONTWANT still only mapped at **11.40% of rows** and **3.11% of IDs**.

| topic source | control | unique IDs | rows | mapped IDs | mapped rows | rows mapped |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| RPC payload/handling | IWANT | 3,700,812 | 56,195,419 | 3,696,929 | 56,181,203 | 99.97% |
| RPC payload/handling | IDONTWANT | 675,563 | 48,779,664 | 14,490 | 2,076,966 | 4.26% |
| IHAVE advert | IWANT | 3,700,812 | 56,195,419 | 3,700,811 | 56,195,417 | 100.00% |
| IHAVE advert | IDONTWANT | 675,563 | 48,779,664 | 21,036 | 5,562,362 | 11.40% |

This was not a midnight-boundary artifact. I widened the topic-source side of the join to a 60-hour window, from June 30 00:00 through July 2 12:00 UTC, while keeping the IDONTWANT control rows fixed to July 1. The IDONTWANT mapping barely moved: **4.26%** of rows found a payload/handling topic source and **11.40%** found an IHAVE topic source.

The small mapped tail is still useful, but only with the caveat stamped on it. Against IHAVE, the largest mapped IDONTWANT bucket was `beacon_block`: **3.68M rows** across **7,179** message IDs. Data-column sidecar topics came after that in little slices. The other **43.2M rows** did not map to an IHAVE topic in the widened check, so treating this as a clean topic leaderboard would be fake precision.

The safe read is boring and useful: **IDONTWANT rows are duplicate-suppression control rows, not rejected gossip messages**. They are also not the negative mirror of IWANT. IWANT is a request for message IDs that show up cleanly in the other libp2p message surfaces. IDONTWANT is a repeated "do not send this ID" signal whose raw row count mostly floats without a topic unless you bring in another table, and even then most of the rows stay unmapped in this sample.

This is an instrumented-node sample, not a full-network bandwidth counter. I would not use it to say Ethereum sent 48.8 million global IDONTWANT messages that day, and I definitely would not call them rejected blocks, rejected attestations, or rejected blobs. The useful unit is narrower: a control row about a gossip `message_id`, observed by this sample, with a lot of repetition.

If you count the rows directly, you get a loud number. If you dedupe first, you get the shape.
