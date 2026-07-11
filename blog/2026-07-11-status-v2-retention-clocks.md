---
slug: status-v2-retention-clocks
title: "Status v2 has two retention clocks in one slot"
description: "In Xatu's July 10 near-head snapshot, Status v2 peers advertised radically different earliest_available_slot windows. The field can mean block history or sidecar history, and it does not say which one set the floor."
authors: aubury
tags: [ethereum, libp2p, peerdas, xatu, data]
date: 2026-07-11
---

`earliest_available_slot` sounds like one clean boundary. It is actually two storage policies squeezed into one integer.

At noon UTC on July 10, I found **14,598 near-head observer-peer pairs** in Xatu Status v2 telemetry. **83.00%** advertised at least the old five-month block-history window, while **3.96%** advertised less than PeerDAS's 18.2-day sidecar window. The split was aggressively client-shaped.

<!-- truncate -->

<img src="/img/status-v2-retention-clocks.png" alt="Stacked bar chart showing Status v2 earliest available slot advertisements by remote agent cohort. Lighthouse, Nimbus, and Teku mostly advertised at least five months, Erigon Caplin clustered around the 18.2-day sidecar window, while Lodestar and Grandine mostly advertised shorter windows." loading="eager" />

The awkward bit is in the [Fulu Status v2 definition](https://github.com/ethereum/consensus-specs/blob/master/specs/fulu/p2p-interface.md#status-v2). If a node has the full required sidecar window, it should advertise the earliest block it can serve. If its sidecar history is shallower, it should advertise the earliest slot from which it can serve all sidecars instead.

That means the field tells you the shallower capability, but not which capability it was. Mainnet's blob and data-column sidecar windows are both [4,096 epochs](https://github.com/ethereum/consensus-specs/blob/master/configs/mainnet.yaml#L183-L210), or **131,072 slots / 18.2 days**. The [long-standing block-serving floor](https://github.com/ethereum/consensus-specs/issues/2116) is **33,024 epochs**, about **146.8 days**.

I used a one-minute noon slice, kept the latest successful outbound Status v2 reply per observer-peer pair, and threw out peers whose reported head was more than 32 slots away from the observer. The remote implementation came from the latest successful `libp2p_identify` exchange for the same peer key.

```sql
-- Status v2 snapshot. The request is the observer; the response is the remote peer.
SELECT
  meta_client_name,
  peer_id_unique_key,
  argMax(request_head_slot,
         tuple(event_date_time, updated_date_time)) AS local_head,
  argMax(response_head_slot,
         tuple(event_date_time, updated_date_time)) AS remote_head,
  argMax(request_earliest_available_slot,
         tuple(event_date_time, updated_date_time)) AS local_earliest,
  argMax(response_earliest_available_slot,
         tuple(event_date_time, updated_date_time)) AS remote_earliest
FROM default.libp2p_handle_status FINAL
WHERE meta_network_name = 'mainnet'
  AND protocol = '/eth2/beacon_chain/req/status/2/ssz_snappy'
  AND direction = 'outbound'
  AND error IS NULL
  AND request_head_slot IS NOT NULL
  AND response_head_slot IS NOT NULL
  AND request_earliest_available_slot IS NOT NULL
  AND response_earliest_available_slot IS NOT NULL
  AND event_date_time >= toDateTime('2026-07-10 12:00:00')
  AND event_date_time <  toDateTime('2026-07-10 12:01:00')
GROUP BY meta_client_name, peer_id_unique_key
HAVING abs(toInt64(local_head) - toInt64(remote_head)) <= 32;

-- Resolve the remote agent separately, then join locally on peer_id_unique_key.
SELECT
  remote_peer_id_unique_key AS peer_id_unique_key,
  argMax(remote_agent_implementation,
         tuple(event_date_time, updated_date_time)) AS implementation
FROM default.libp2p_identify FINAL
WHERE meta_network_name = 'mainnet'
  AND success
  AND event_date_time >= toDateTime('2026-06-10 00:00:00')
  AND event_date_time <  toDateTime('2026-07-11 00:00:00')
GROUP BY peer_id_unique_key;
```

The reduction left **14,598 pairs over 8,092 remote peer keys**. Another **6.83%** returned slot `0`, an explicit genesis-history advertisement, and **6.21%** landed between 18.2 days and five months. I kept observer-peer pairs as the denominator because one remote peer can appear under several observers.

The client cohorts did not merely wobble around one cutoff. Lighthouse's nonzero median was **258.8 days**, Nimbus and Teku sat around **146.9 days**, and Erigon/Caplin sat almost exactly on **4,096 epochs** at **18.204 days**. Lodestar and Grandine were the other extreme: their nonzero medians were **10.3** and **10.0 days** in this snapshot. Those are advertisements, not proof that an old block or sidecar request would succeed.

This was not a lucky minute. I repeated the same latest-per-pair, near-head reduction at noon for 14 days. The share advertising at least five months stayed between **79.71% and 83.00%**; the under-18.2-day share stayed between **3.96% and 4.66%**. Every observer request in the final July 10 minute carried `request_earliest_available_slot = 0`, while the remote responses spread across the chart's buckets.

There is no client market-share claim here. The table comes from a Tysm-instrumented observer surface, and repeated pair snapshots are not unique Ethereum nodes. The useful finding is narrower: `earliest_available_slot` cannot be read as a typed "block history begins here" field. Sometimes it is the block clock, sometimes it is the sidecar clock, and the wire value does not tell you which one won.
