---
slug: teku-quic-enr-surface
title: Teku's QUIC release shows up as an ENR field
description: On July 1, six of seven observed Teku v26.7.0 ENRs advertised quic=9001, while older Teku versions in the same peer-surface sample did not.
authors: [aubury]
tags: [ethereum, teku, quic, p2p, data]
date: 2026-07-02
---

Teku 26.7.0 landed with a very specific operational note: QUIC p2p is enabled by default, on UDP port 9001 for IPv4. That is the kind of release-note claim that should leave a mark in the peer records if the release is actually visible on mainnet.

It did, but the shape was not "Ethereum just got QUIC." Most of the consensus ENRs I saw already had a `quic` port. Teku was the laggard.

<!-- truncate -->

<img src="/img/teku-quic-enr-surface.png" alt="Mainnet consensus ENRs with a parsed QUIC port by client implementation and Teku version on 2026-07-01 UTC" loading="eager" />

The table here is `node_record_consensus`. It is not a node census and it is not a connectivity test. It is a discoverable ENR surface: a Xatu observer saw an ENR, parsed fields like `tcp`, `udp`, and `quic`, and stored the row. That makes it good for one narrow question: did peers advertise a QUIC port?

Here is the query I used for the UTC day the Teku release note appeared:

```sql
WITH latest AS (
  SELECT
    node_id,
    argMax(implementation, event_date_time) AS implementation,
    argMax(version, event_date_time) AS version,
    argMax(quic, event_date_time) AS quic,
    max(event_date_time) AS last_seen
  FROM node_record_consensus
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-01 00:00:00')
    AND event_date_time <  toDateTime('2026-07-02 00:00:00')
  GROUP BY node_id
)
SELECT
  implementation,
  count() AS nodes,
  countIf(not isNull(quic) AND quic != 0) AS quic_nodes,
  round(quic_nodes / nodes * 100, 2) AS quic_pct
FROM latest
GROUP BY implementation
ORDER BY nodes DESC;
```

That day had **2,403 raw node-record rows**, **994 distinct node IDs**, and one unnamed Xatu observer in the sample. Prysm was **487 / 487** with a parsed `quic` port. Lighthouse was **315 / 317**. Grandine, Tysm, and the small rust-libp2p bucket were also all `quic`-positive in this sample. Lodestar was mixed at **68 / 86**.

Teku was the odd one out among the larger buckets: **6 / 50** Teku ENRs had a parsed `quic` port. Erigon/Caplin was also **0 / 20**, so this is not a claim that Teku was the only client without QUIC in ENR. The difference is that Teku had a fresh release note saying QUIC was now on by default, and the version split showed exactly where the field appeared.

The Teku-only cut is blunt:

```sql
WITH latest AS (
  SELECT
    node_id,
    argMax(version, event_date_time) AS version,
    argMax(quic, event_date_time) AS quic
  FROM node_record_consensus
  WHERE meta_network_name = 'mainnet'
    AND implementation = 'teku'
    AND event_date_time >= toDateTime('2026-07-01 00:00:00')
    AND event_date_time <  toDateTime('2026-07-02 00:00:00')
  GROUP BY node_id
)
SELECT
  version,
  count() AS nodes,
  countIf(not isNull(quic) AND quic != 0) AS quic_nodes
FROM latest
GROUP BY version
ORDER BY nodes DESC;
```

Old Teku stayed dark in the July 1 sample. `v26.6.1` had **18** nodes and **0** `quic` fields. `v26.4.0` had **11 / 0**, `v26.3.0` had **8 / 0**, and `v26.6.0` had **4 / 0**. `v26.7.0` had **7** nodes, **6** of them advertising `quic=9001`.

That looks like the release note showing up directly in ENR parsing. It is not a perfect upgrade cohort, though. When I checked the seven `v26.7.0` node IDs against their pre-release history, only two had a clean previous state in the June 25 through July 1 window: both were `v26.6.1`, both had no `quic` field before, and both later had one. Three had no prior record in that bounded window, one was already visible as `v26.7.0` before the GitHub release timestamp, and one `v26.7.0` ENR still had no parsed `quic` port.

That last bit matters. Release timestamps are not network activation timestamps, and an ENR field is not a successful handshake. A node can advertise a port while a firewall drops UDP. A node can also be missing from this table entirely because discovery did not see it.

So the safe label is ugly but accurate: **advertises QUIC in ENR**.

For Teku 26.7.0, that label mostly flipped on. For older Teku, it did not. For most of the rest of the observed peer surface, QUIC was already there before Teku joined the party.
