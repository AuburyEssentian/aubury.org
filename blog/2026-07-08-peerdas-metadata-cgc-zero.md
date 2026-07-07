---
slug: peerdas-metadata-cgc-zero
title: "Metadata said four. ENR still said zero."
description: "In seven complete UTC days, 23 probed PeerDAS peers advertised ENR cgc=0 while their latest metadata said custody_group_count=4. They still missed 35.9% of raw custody probes."
authors: aubury
tags: [ethereum, peerdas, p2p, xatu, data]
date: 2026-07-08
---

PeerDAS now has two places where a peer can tell you how many custody groups it claims to serve. I expected the live metadata handshake to clean up the old `cgc=0` ENR hole. Instead it hid it.

<!-- truncate -->

I wrote a couple of weeks ago that [PeerDAS had a custody count trap](/blog/peerdas-custody-count-trap/): peers advertising ENR `cgc=0` were a small bucket, but they missed custody probes at a silly rate. That post used discovery ENRs from `node_record_consensus` and probe results. The obvious follow-up was to stop trusting the discovery record so much and ask the newer libp2p metadata surface what the peer said during request/response.

The spec gives both surfaces. The ENR has a `cgc` key: a big-endian custody group count where zero is encoded as an empty byte string. The Fulu metadata object also carries `custody_group_count`, next to `seq_number`, `attnets`, and `syncnets`. Same idea, different clock: one is what discovery saw, the other is what a connected peer answered through `/eth2/beacon_chain/req/metadata/3/ssz_snappy`.

The metadata-only view looked almost too clean. Across the seven complete UTC days from **2026-06-30 through 2026-07-06**, I took the latest successful `libp2p_handle_metadata` row per peer. That gave **19,185** peers. Only **4** had latest `custody_group_count = 0`, and none of those four showed up in the bounded custody-probe set I used for the chart.

Then I joined the same probe set back to the latest ENR `cgc` from `node_record_consensus`, parsed the hex, and the old hole came back:

<img src="/img/peerdas-metadata-cgc-zero.png" alt="PeerDAS custody probes grouped by ENR and metadata custody group count, with ENR cgc=0 peers missing 35.9% of probes even though their latest metadata said cgc=4" loading="eager" />

The awkward bucket is tiny but very real in this sample: **23 probed peers** whose latest ENR said `cgc=0`. They had **146,160** raw custody-probe rows. **52,535** were `missing`, which is **35.94%**. Every one of those 23 peers had latest successful metadata saying `custody_group_count = 4`.

Here is the exact shape of the query. I kept the three surfaces separate and merged locally, because raw distributed joins are a great way to accidentally turn a small semantic check into a cluster workout:

```python
START = "2026-06-30 00:00:00"
END = "2026-07-07 00:00:00"

metadata = clickhouse.query("clickhouse-raw", f"""
SELECT
  peer_id_unique_key,
  argMax(custody_group_count, event_date_time) AS metadata_cgc,
  max(event_date_time) AS metadata_last_seen
FROM default.libp2p_handle_metadata
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('{START}')
  AND event_date_time <  toDateTime('{END}')
  AND (error IS NULL OR error = '')
GROUP BY peer_id_unique_key
""")

enr = clickhouse.query("clickhouse-raw", f"""
SELECT
  peer_id_unique_key,
  argMax(cgc, event_date_time) AS enr_cgc_raw,
  max(event_date_time) AS enr_last_seen
FROM default.node_record_consensus
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('{START}')
  AND event_date_time <  toDateTime('{END}')
  AND peer_id_unique_key IS NOT NULL
GROUP BY peer_id_unique_key
""")

raw_probes = clickhouse.query("clickhouse-raw", f"""
SELECT
  peer_id_unique_key,
  count() AS probe_rows,
  countIf(result = 'success') AS success_rows,
  countIf(result = 'missing') AS missing_rows,
  countIf(result = 'failure') AS failure_rows
FROM default.libp2p_rpc_data_column_custody_probe
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('{START}')
  AND event_date_time <  toDateTime('{END}')
  AND slot_start_date_time >= toDateTime('{START}')
  AND slot_start_date_time <  toDateTime('{END}')
GROUP BY peer_id_unique_key
""")
```

The cross-check used the refined probe table, but counted column units rather than refined rows because `mainnet.int_custody_probe` batches `column_indices` into arrays. That gave the same answer within four raw rows: **146,156** refined column units for the ENR-zero bucket, **52,535** missing. The denominator moved by rounding dust; the hole did not.

```sql
SELECT
  peer_id_unique_key,
  sum(length(column_indices)) AS refined_column_units,
  sumIf(length(column_indices), result = 'success') AS refined_success_units,
  sumIf(length(column_indices), result = 'missing') AS refined_missing_units,
  sumIf(length(column_indices), result = 'failure') AS refined_failure_units
FROM mainnet.int_custody_probe
WHERE probe_date_time >= toDateTime('2026-06-30 00:00:00')
  AND probe_date_time <  toDateTime('2026-07-07 00:00:00')
  AND slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-07 00:00:00')
GROUP BY peer_id_unique_key;
```

The timing makes this more annoying, not less. For **22 of the 23** ENR-zero peers, the latest successful metadata row was newer than the latest ENR row in the same window. The median gap was **23.6 hours**. So the naive story is not "metadata was stale and ENR was fresh." If anything, the metadata answer looked fresher and healthier.

I do not want to oversell that as a client bug. This is an observed Xatu peer/probe surface, not a validator census, and the join uses latest rows inside a week rather than reconstructing each peer's exact state before every probe. The daily shape also improved: the same 23 peers were missing **58.3%** of bounded raw probes on Jun 30 and **22.7%** on Jul 6. That is still ugly, but it is not a flat line.

The safer conclusion is the useful one: do not collapse ENR `cgc` and metadata `custody_group_count` into one field just because the names rhyme. Metadata-only grouping put the bad ENR-zero peers into the huge `custody_group_count = 4` bucket, where the missing rate looked normal at **2.00%**. ENR grouping kept the scar visible.

That is the trap. PeerDAS custody count is not just a number; it is a number from a surface at a time. When the surfaces disagree, the probe table gets the deciding vote.
