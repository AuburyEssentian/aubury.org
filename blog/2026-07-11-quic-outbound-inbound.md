---
slug: quic-outbound-inbound
title: "QUIC was already common. It just wasn't coming in."
description: "Across 14 days of Tysm-instrumented mainnet connection opens, UDP/QUIC carried 43.56% of outbound sessions but only 0.0036% of inbound sessions."
authors: aubury
tags: [ethereum, libp2p, quic, xatu, data]
date: 2026-07-11
---

Ethereum's consensus spec just made QUIC the mandatory, preferred libp2p transport. Xatu's connection rows show that QUIC was already doing plenty of work, but almost entirely in one direction.

Across June 27 through July 10, the Tysm-instrumented mainnet sample recorded **6,884,989 outbound UDP/QUIC session opens**, or **43.56%** of outbound opens. The inbound side had **88**. That is **0.0036%** of 2.43 million inbound opens.

<!-- truncate -->

<img src="/img/quic-outbound-inbound.png" alt="Line chart showing UDP and QUIC transport at 42 to 45 percent of outbound libp2p session opens but effectively zero percent of inbound opens in the Tysm-instrumented Xatu mainnet sample from June 27 through July 10, 2026." loading="eager" />

The [consensus-spec change merged on July 6](https://github.com/ethereum/consensus-specs/pull/5330) and shipped in the [July 8 alpha release](https://github.com/ethereum/consensus-specs/releases/tag/v1.7.0-alpha.12). When a peer is reachable over both transports, clients should dial QUIC first and fall back to TCP if QUIC cannot be established. The chart's release marker is context, not a before-and-after claim. A spec release does not reset existing connections or prove that deployed clients changed that day.

The awkward bit is the Xatu field name. `libp2p_connected.remote_transport_protocol` says `udp`, not `quic-v1`, so I did not simply rename every UDP row and move on. I matched the July 10 connection endpoints to each peer's latest consensus ENR from the same 14-day window. Among outbound session edges matched to peers advertising QUIC, **281,602 of 281,709 UDP edges used the advertised QUIC port: 99.96%**.

I kept the connection tables at their actual grain. The semantic session key is observer, remote peer, direction, and `opened`; counting raw rows adds a small replacement-table multiplier that has nothing to do with transport adoption.

```sql
SELECT
  toDate(event_date_time) AS day,
  remote_transport_protocol AS transport,
  direction,
  count() AS rows,
  uniqExact(tuple(
    meta_client_name,
    remote_peer_id_unique_key,
    direction,
    opened
  )) AS session_edges,
  uniqExact(remote_peer_id_unique_key) AS remote_peer_keys,
  uniqExact(meta_client_name) AS observers
FROM default.libp2p_connected FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-27 00:00:00')
  AND event_date_time <  toDateTime('2026-07-11 00:00:00')
GROUP BY day, transport, direction
ORDER BY day, direction, transport;
```

The outbound UDP share was not one noisy day. It stayed between **41.89% and 44.64%** on every complete UTC day in the window. The inbound share peaked at **0.0154%** and hit literal zero on five days.

For the ENR check, I fetched bounded connection endpoints and latest ENRs separately, then joined them locally by peer key. That avoids pretending a large distributed raw-table join is more trustworthy than it is.

```sql
-- Connection endpoints for one complete day.
SELECT
  remote_peer_id_unique_key AS peer_key,
  remote_transport_protocol AS transport,
  remote_port,
  direction,
  uniqExact(tuple(
    meta_client_name,
    remote_peer_id_unique_key,
    direction,
    opened
  )) AS session_edges
FROM default.libp2p_connected FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-10 00:00:00')
  AND event_date_time <  toDateTime('2026-07-11 00:00:00')
GROUP BY peer_key, transport, remote_port, direction;

-- Latest advertised ports in the same research window.
SELECT
  peer_id_unique_key AS peer_key,
  argMax(quic, tuple(event_date_time, updated_date_time)) AS quic_port,
  argMax(tcp,  tuple(event_date_time, updated_date_time)) AS tcp_port
FROM default.node_record_consensus
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-27 00:00:00')
  AND event_date_time <  toDateTime('2026-07-11 00:00:00')
  AND peer_id_unique_key IS NOT NULL
GROUP BY peer_key;
```

That latest-ENR subset is useful but incomplete. It matched 3,380 of 14,832 connected peer keys on July 10, and the latest ENR is not guaranteed to be the exact advertisement used for every earlier connection. Within the matched QUIC-advertising subset, though, **72.39%** of 389,131 outbound session edges used UDP/QUIC and **27.61%** used TCP. The endpoint-port match is why I am comfortable calling these UDP rows QUIC; it is not a claim that every UDP row in every Xatu table means QUIC.

Two cross-checks survived. `libp2p_disconnected FINAL` had 6,884,545 outbound UDP closes and 8,920,728 outbound TCP closes in the same window, within **0.01%** of the corresponding open counts. On July 10, `libp2p_identify FINAL` also recorded 210,154 successful outbound identify rows over UDP, so this was not an ENR-only capability that never reached a live protocol exchange.

There is no Ethereum-wide transport share here. These are repeated session opens from one instrumented client surface, not unique nodes, dial attempts, or a QUIC success rate. The failed identify rows also do not retain a transport label, which kills any honest attempt to calculate the QUIC-to-TCP fallback rate from this table alone.

The safe read is narrower and weirder: these sentries were active QUIC dialers, while inbound QUIC was basically absent. QUIC is not waiting to exist on Ethereum. On this surface, it was already carrying nearly half the outbound connection churn and almost none of the inbound side.
