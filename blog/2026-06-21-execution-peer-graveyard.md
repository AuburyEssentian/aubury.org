---
slug: execution-peer-graveyard
title: "Ethereum's execution peer set has a zombie wing"
description: "In seven complete UTC days of mainnet execution-node discovery, 13.9% of distinct node IDs advertised old fork IDs. Most of them were not one fork behind. They reported the mainnet genesis head."
authors: aubury
tags: [ethereum, execution-layer, p2p, data]
date: 2026-06-21
---

A stale execution peer is not always a node that forgot the latest fork.

Sometimes it is a modern client binary sitting at the mainnet genesis block and politely telling the world it is ready for Homestead.

Across seven complete UTC days, **201 of 1,444** discovered mainnet execution node IDs advertised old fork IDs. **164** of those had the old Frontier fork ID, `0xfc64ec04`, with `next = 1150000`.

That is not "slightly behind."

That is genesis.

<!-- truncate -->

<img src="/img/execution-peer-graveyard.png" alt="Ethereum execution peer fork ID chart showing 13.9% of discovered node IDs advertising old fork IDs, mostly genesis head / frontier or unsynced peers" loading="eager" />

The fork-ID part matters because this is not me inventing a label. Geth's own fork-ID test calls this pair unsynced:

```go
{0, 0, ID{Hash: checksumToBytes(0xfc64ec04), Next: 1150000}}, // Unsynced
{50000000, 2000000000, ID{Hash: checksumToBytes(0x07c9462e), Next: 0}}, // Future BPO2 block
```

`0x07c9462e / 0` is the current mainnet fork ID after the January BPO2 change. `0xfc64ec04 / 1150000` is the fork ID you get at block zero, before Homestead.

So I asked a dumb question: how much of the discoverable execution peer surface is actually advertising the current chain?

This is the query. It takes the latest record per `node_id` seen from June 13 through June 19, then buckets the advertised fork ID.

```sql
WITH latest AS (
  SELECT
    node_id,
    argMax(implementation, event_date_time) AS impl,
    argMax(version, event_date_time) AS version,
    argMax(fork_id_hash, event_date_time) AS fork_hash,
    argMax(fork_id_next, event_date_time) AS fork_next,
    argMax(head, event_date_time) AS head,
    argMax(ip, event_date_time) AS ip,
    argMax(geo_autonomous_system_organization, event_date_time) AS asn_org
  FROM node_record_execution
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-13 00:00:00')
    AND event_date_time < toDateTime('2026-06-20 00:00:00')
  GROUP BY node_id
), labeled AS (
  SELECT
    *,
    multiIf(
      fork_hash = '0x07c9462e' AND fork_next = '0', 'current/BPO2',
      fork_hash = '0xfc64ec04' AND fork_next = '1150000', 'frontier-or-unsynced',
      fork_hash = '0xc376cf8b' AND fork_next = '1764798551', 'pre-Fulu/Prague',
      fork_next IN ('1681338455', '1710338135')
        OR fork_hash IN ('0xf0afd0e3', '0xdce96c2d'), 'pre-Pectra-or-Dencun',
      'other-old'
    ) AS state
  FROM latest
)
SELECT
  state,
  count() AS nodes,
  round(100 * nodes / sum(nodes) OVER (), 2) AS pct,
  uniqExact(ip) AS ips,
  uniqExact(asn_org) AS asns
FROM labeled
GROUP BY state
ORDER BY nodes DESC
```

Result:

| fork state | node IDs | share | distinct IPs | ASNs |
|---|---:|---:|---:|---:|
| current/BPO2 | 1,243 | 86.08% | 1,165 | 255 |
| frontier-or-unsynced | 164 | 11.36% | 149 | 29 |
| other old fork IDs | 19 | 1.32% | 17 | 13 |
| pre-Fulu/Prague | 13 | 0.90% | 7 | 5 |
| pre-Pectra-or-Dencun | 5 | 0.35% | 5 | 5 |

The ugly bit is the `head` field.

For the 164 `frontier-or-unsynced` peers, the latest advertised head was the mainnet genesis hash:

```text
0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3
```

Not a Prague head. Not a Dencun head. Not a node that missed BPO2.

Genesis.

That group was not just ancient software either. The biggest cluster was Geth `v1.16.7`, but the same genesis-head bucket also had Reth `v2.2.0`, Reth `v2.3.0`, Erigon `v3.4.x`, and a couple of Ethrex nodes. Fresh binary, dead chain state.

Split by implementation:

| implementation | total node IDs | current | old | old share |
|---|---:|---:|---:|---:|
| Nimbus EL | 16 | 8 | 8 | 50.0% |
| Erigon | 121 | 91 | 30 | 24.8% |
| Geth | 941 | 809 | 132 | 14.0% |
| Reth | 172 | 148 | 24 | 14.0% |
| Besu | 30 | 27 | 3 | 10.0% |
| Nethermind | 150 | 150 | 0 | 0.0% |

Do not read that as client market share. This table is a discoverability surface, not a validator census, and the sample is shaped by what the discovery crawler can reach.

But that caveat cuts both ways. These are exactly the peers a node-discovery system can find. If a peer table says "I found 1,400 execution nodes," somewhere around one in seven of those advertised a fork ID that a current mainnet node should not use for useful peering.

The daily view was not a one-hour scrape artifact either. The old-fork share bounced around, but it never went away:

| day | discovered node IDs | old or unsynced | share |
|---|---:|---:|---:|
| Jun 6 | 405 | 28 | 6.91% |
| Jun 7 | 386 | 22 | 5.70% |
| Jun 8 | 448 | 48 | 10.71% |
| Jun 9 | 448 | 32 | 7.14% |
| Jun 10 | 474 | 50 | 10.55% |
| Jun 11 | 440 | 30 | 6.82% |
| Jun 12 | 413 | 36 | 8.72% |
| Jun 13 | 346 | 17 | 4.91% |
| Jun 14 | 365 | 25 | 6.85% |
| Jun 15 | 425 | 71 | 16.71% |
| Jun 16 | 376 | 41 | 10.90% |
| Jun 17 | 412 | 42 | 10.19% |
| Jun 18 | 448 | 40 | 8.93% |
| Jun 19 | 391 | 33 | 8.44% |

My guess is boring and annoying: lots of short-lived or misconfigured execution clients start up, bind P2P, advertise an ENR, and sit at genesis long enough to be crawled. Some may be abandoned nodes. Some may be cloud images caught mid-sync. Some may be test rigs pointed at mainnet discovery by accident.

The important part is not whether they hurt consensus. They probably do not. A synced node should reject stale peers through fork-ID checks.

The important part is counting.

Raw peer counts include ghosts. Fork ID and head hash are the cheap sanity check. Without them, a peer table can look healthier than the network it actually represents.