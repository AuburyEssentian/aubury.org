---
slug: execution-peer-network-label-genesis
title: "`mainnet` peer rows now carry 116 genesis hashes"
description: "After Xatu widened execution-peer capture, 20.7% of peer IDs in a four-hour mainnet-labelled sample reported a different genesis hash."
authors: aubury
tags: [ethereum, execution-layer, p2p, data-quality]
date: 2026-07-15
---

`meta_network_name = 'mainnet'` used to look like enough of a chain filter. It is not anymore.

In four complete hours after Xatu widened its execution-peer capture, `node_record_execution` held **3,075 peer IDs** under the `mainnet` label. **637 of them, 20.72%, reported a genesis hash that was not Ethereum mainnet's.** The sample contained 116 distinct genesis values in total.

This is not mainnet suddenly splitting into 116 chains. The label belongs to the observation path; the remote peer's genesis is a separate field.

<!-- truncate -->

<a href="/img/execution-peer-network-label-genesis.png?v=20260715-2">
  <img src="/img/execution-peer-network-label-genesis.png?v=20260715-2" alt="Stacked bars showing that 20.7% of mainnet-labelled execution peer IDs, 37.1% of Sepolia-labelled IDs, and 29.7% of Hoodi-labelled IDs reported a different genesis" loading="eager" />
</a>

I checked the same fixed window for the three network labels with enough fresh coverage. The mismatch was not a mainnet-only edge case. Just **62.86%** of Sepolia-labelled peer IDs reported the Sepolia genesis, and **70.35%** of Hoodi-labelled IDs reported the Hoodi genesis.

The constants below are the [mainnet, Sepolia, and Hoodi genesis hashes in go-ethereum](https://github.com/ethereum/go-ethereum/blob/v1.17.4/params/config.go). The query keeps the latest record per `(meta_network_name, node_id)` before comparing the remote `genesis` field with the row's network label.

```sql
WITH latest AS (
  SELECT
    meta_network_name,
    node_id,
    argMax(genesis, tuple(event_date_time, updated_date_time)) AS genesis
  FROM default.node_record_execution FINAL
  WHERE meta_network_name IN ('mainnet', 'sepolia', 'hoodi')
    AND event_date_time >= toDateTime('2026-07-14 11:00:00')
    AND event_date_time <  toDateTime('2026-07-14 15:00:00')
  GROUP BY meta_network_name, node_id
)
SELECT
  meta_network_name,
  count() AS peer_ids,
  countIf(genesis =
    '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'
  ) AS mainnet_genesis,
  countIf(genesis =
    '0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9'
  ) AS sepolia_genesis,
  countIf(genesis =
    '0xbbe312868b376a3001692a646dd2d7d1e4406380dfd86b98aa8a34d1557c971b'
  ) AS hoodi_genesis,
  countIf(genesis NOT IN (
    '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
    '0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9',
    '0xbbe312868b376a3001692a646dd2d7d1e4406380dfd86b98aa8a34d1557c971b'
  )) AS other_genesis,
  uniqExact(genesis) AS genesis_hashes,
  round(100.0 * countIf(genesis = multiIf(
    meta_network_name = 'mainnet',
      '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
    meta_network_name = 'sepolia',
      '0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9',
    '0xbbe312868b376a3001692a646dd2d7d1e4406380dfd86b98aa8a34d1557c971b'
  )) / count(), 2) AS matching_genesis_pct
FROM latest
GROUP BY meta_network_name
ORDER BY meta_network_name
```

The result is easier to read as three separate denominators:

- `mainnet`: **3,075 peer IDs**. 2,438 matched mainnet (79.28%); 637 reported a different genesis; the rows carried 116 distinct genesis values.
- `sepolia`: **735 peer IDs**. 462 matched Sepolia (62.86%); 273 reported a different genesis; the rows carried 77 distinct genesis values.
- `hoodi`: **715 peer IDs**. 503 matched Hoodi (70.35%); 212 reported a different genesis; the rows carried 74 distinct genesis values.

The timing made the source boundary hard to miss. [Xatu v1.21.0](https://github.com/ethpandaops/xatu/releases/tag/v1.21.0) shipped at 03:46 UTC on July 13. Its main change was [emitting `NODE_RECORD_EXECUTION` for execution status messages captured by Mimicry](https://github.com/ethpandaops/xatu/pull/876), using the same event shape as the older discovery path.

A same-length four-hour comparison shows what that did to the table. Observer coverage under the `mainnet` label went from one source to ten, while the peer-ID set grew from 139 to 3,075. The old window had one genesis value. The new window had 116.

```sql
WITH
  '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'
    AS mainnet_genesis,
  pre_latest AS (
    SELECT
      node_id,
      argMax(genesis, tuple(event_date_time, updated_date_time)) AS genesis
    FROM default.node_record_execution FINAL
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-07-12 11:00:00')
      AND event_date_time <  toDateTime('2026-07-12 15:00:00')
    GROUP BY node_id
  ),
  post_latest AS (
    SELECT
      node_id,
      argMax(genesis, tuple(event_date_time, updated_date_time)) AS genesis
    FROM default.node_record_execution FINAL
    WHERE meta_network_name = 'mainnet'
      AND event_date_time >= toDateTime('2026-07-14 11:00:00')
      AND event_date_time <  toDateTime('2026-07-14 15:00:00')
    GROUP BY node_id
  )
SELECT
  'Jul 12 11:00-15:00' AS window,
  (SELECT uniqExact(meta_client_name)
   FROM default.node_record_execution FINAL
   WHERE meta_network_name = 'mainnet'
     AND event_date_time >= toDateTime('2026-07-12 11:00:00')
     AND event_date_time <  toDateTime('2026-07-12 15:00:00')) AS observers,
  count() AS peer_ids,
  countIf(genesis = mainnet_genesis) AS mainnet_genesis_ids,
  countIf(genesis != mainnet_genesis) AS other_genesis_ids,
  uniqExact(genesis) AS genesis_values
FROM pre_latest
UNION ALL
SELECT
  'Jul 14 11:00-15:00' AS window,
  (SELECT uniqExact(meta_client_name)
   FROM default.node_record_execution FINAL
   WHERE meta_network_name = 'mainnet'
     AND event_date_time >= toDateTime('2026-07-14 11:00:00')
     AND event_date_time <  toDateTime('2026-07-14 15:00:00')) AS observers,
  count() AS peer_ids,
  countIf(genesis = mainnet_genesis) AS mainnet_genesis_ids,
  countIf(genesis != mainnet_genesis) AS other_genesis_ids,
  uniqExact(genesis) AS genesis_values
FROM post_latest
ORDER BY window
```

| window (UTC) | observers | peer IDs | mainnet genesis | other genesis | genesis values |
|---|---:|---:|---:|---:|---:|
| Jul 12, 11:00-15:00 | 1 | 139 | 139 | 0 | 1 |
| Jul 14, 11:00-15:00 | 10 | 3,075 | 2,438 | 637 | 116 |

The code explains how the two identities can separate. Mimicry reads `network_id`, `genesis`, head, and fork ID from the remote status. If `OverrideNetworkName` is configured, though, [that configured name is written into event metadata](https://github.com/ethpandaops/xatu/blob/a83a609259acd353cc0d0625688964efdbc7c5c7/pkg/mimicry/p2p/execution/execution.go); the remote genesis still goes into the node-record payload. The ClickHouse table exposes both `meta_network_name` and `genesis`, but not the remote network ID from that status message.

That makes the safe query order pretty boring: filter the remote genesis first, then reduce to the latest row per peer ID. Filtering only `meta_network_name = 'mainnet'` now mixes capture context with chain identity.

This does not measure node count, client share, or durable connections. A row says an instrumented observer got far enough into the execution handshake to emit a status-shaped record. The sample also changed from one observer to ten in two days, so the jump from 139 to 3,075 peer IDs is not a growth trend.

I used this table in June to write about [genesis-head zombie peers](/blog/execution-peer-graveyard/). That historical window predates the new capture sources, so its result still holds. The query pattern does not: a current rerun needs the mainnet genesis guard before it starts counting stale fork IDs.

`meta_network_name` tells me where the observation was filed. `genesis` tells me what chain the remote peer actually claimed. For peer counts, I trust the second one.
