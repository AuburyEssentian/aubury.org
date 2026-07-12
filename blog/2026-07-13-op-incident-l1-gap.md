---
slug: op-incident-l1-gap
title: "OP was producing blocks while its L1 batcher went quiet"
description: "OP Mainnet's July 7 distribution incident overlapped a 23m24s hole in its Ethereum blob-posting rhythm, the longest gap in a 14-day scan."
authors: [aubury]
tags: [ethereum, optimism, rollups, blobs, xatu]
date: 2026-07-13
---

Optimism's July 7 status update was oddly specific: after a brief unsafe-head stall, the sequencer was producing blocks again, but some nodes were not syncing. Ethereum saw another symptom at almost exactly the same time. OP Mainnet's L1 blob batcher stopped posting for **23 minutes and 24 seconds**, its longest gap in a scan of 14 complete days.

<!-- truncate -->

The [public incident](https://status.optimism.io/incident/cmrazrvph0am30rns9tzwb2oa) started at **18:03 UTC**, moved to monitoring at **18:23**, and was resolved at **19:35**. The L1 gap ran from **17:57:11 to 18:20:35**. It started 5m49s before the incident update and ended 2m25s before monitoring began.

I used OP's blob sender as a heartbeat, not as a reconstruction of the L2. `mainnet.dim_block_blob_submitter` labels `0x6887246668a3b87f54deb3b94ba47a6f63f32985` as OP Mainnet, but that mapping lagged the incident window. I used it to identify the sender, then counted recent transactions directly from canonical beacon payloads. That distinction matters: a stale name table is fine for a stable address label and lousy for fresh activity counts.

Here is the publication path. It reduces the raw table to one row per transaction hash before calculating the gaps locally.

```python
from ethpandaops import clickhouse
import pandas as pd

op = clickhouse.query("clickhouse-raw", """
SELECT
  hash,
  min(slot_start_date_time) AS ts,
  any(slot) AS slot,
  any(length(blob_hashes)) AS blobs,
  any(blob_sidecars_size) AS sidecar_bytes,
  any(blob_sidecars_empty_size) AS empty_bytes
FROM default.canonical_beacon_block_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-28 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-12 00:00:00')
  AND type = 3
  AND lower(`from`) = '0x6887246668a3b87f54deb3b94ba47a6f63f32985'
GROUP BY hash
ORDER BY ts
""")

op["ts"] = pd.to_datetime(op["ts"])
op["gap_seconds"] = op["ts"].diff().dt.total_seconds()
```

The 14-day window contained **5,103 OP blob transactions** and therefore **5,102 inter-transaction gaps**. The median gap was 4m12s and the p99 was 9m48s. The next-largest gap was 14m48s. The incident gap was the only one longer than 20 minutes.

<img src="/img/op-incident-l1-gap.png" alt="Timeline of OP Mainnet blob transactions on July 7, showing a 23 minute 24 second gap from 17:57:11 to 18:20:35 UTC overlapping the public Optimism outage from 18:03 to 18:23." loading="eager" />

I checked the clock through a second raw path because timestamp joins are an easy place to manufacture a clean story. I fetched OP's type-3 transactions from `canonical_execution_transaction`, fetched block timestamps separately from `canonical_execution_block`, deduped each side by its semantic key, and joined locally on block number.

```sql
-- Transaction side, bounded to blocks 25,412,425 through 25,512,815
SELECT
  transaction_hash,
  any(block_number) AS tx_block_number,
  any(transaction_index) AS transaction_index
FROM default.canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25412425 AND 25512815
  AND transaction_type = 3
  AND lower(from_address) = '0x6887246668a3b87f54deb3b94ba47a6f63f32985'
GROUP BY transaction_hash;

-- Block side, joined in Python after this query
SELECT
  block_number,
  min(block_date_time) AS block_ts
FROM default.canonical_execution_block
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25412425 AND 25512815
GROUP BY block_number;
```

That route returned the same **5,103 transaction hashes**, with all 5,103 matching the beacon-payload path and no missing block timestamps. It reproduced the same 17:57:11 to 18:20:35 gap exactly.

Ethereum itself did not go quiet. During those 23m24s, 46 other senders landed **138 type-3 transactions carrying 360 blobs**. The refined canonical count independently found those 360 blobs across 77 blob-carrying blocks.

```sql
SELECT
  countIf(status = 'canonical' AND blob_count > 0) AS canonical_blob_blocks,
  sumIf(blob_count, status = 'canonical') AS canonical_blobs
FROM mainnet.fct_block_blob_count FINAL
WHERE slot_start_date_time > toDateTime('2026-07-07 17:57:11')
  AND slot_start_date_time < toDateTime('2026-07-07 18:20:35');
```

The restart was not a giant dump. OP posted twice before the incident moved to monitoring, at 18:20:35 and 18:22:35, then settled back into its usual rhythm. The two hours before the incident had 25 transactions and 125 blobs; the two hours after monitoring began had 28 transactions and 140 blobs. That is a little busier, but not enough to pretend I can measure an L2 backlog from L1 alone.

The narrow read is the useful one. Optimism said the sequencer had resumed while parts of the network were still not syncing. For most of that public partial-outage window, the canonical L1 batch heartbeat was missing too. This does not identify the broken component, and it does not prove that produced L2 blocks were lost. It does show that the distribution problem reached farther than an RPC status page: OP's normal route for publishing batches to Ethereum paused at the same time.
