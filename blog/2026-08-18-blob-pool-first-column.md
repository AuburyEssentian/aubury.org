---
slug: blob-pool-first-column
title: "The blob pool fills before the first data column arrives"
description: "Across eight fixed mainnet observers and 14 complete days, 88.83% of canonical blob cell positions had been seen at slot start. By the first PeerDAS data column, 98.71% had."
authors: aubury
tags: [ethereum, peerdas, blobs, mempool, data]
date: 2026-08-18
---

At slot start, Ethereum's blob pool did not look ready. Roughly 1.5 seconds later, it did.

Across eight fixed mainnet observers and 14 complete UTC days, **88.83%** of canonical blob cell positions had been seen when the slot began. By the time the same observer saw its first PeerDAS data column, the share was **98.71%**. The missing ten percentage points mostly arrived in the small gap before the block and its data turned up.

<!-- truncate -->

That is useful timing for [EIP-8136](https://eips.ethereum.org/EIPS/eip-8136), which moved to Review on August 11. The proposal lets peers exchange only the cells they still need instead of pushing a full data column every time. Its premise is blunt: most blobs referenced by a block are already in the local mempool, so sending those cells again wastes bandwidth.

At the slot boundary, that premise looks shaky. At the actual data-column boundary, it looks very good.

<img src="/img/blob-pool-first-column.png" alt="Daily share of canonical blob cell positions seen by the same observer at slot start and before its first PeerDAS data column, rising from a 14-day weighted 88.83% to 98.71%" loading="eager" />

The denominator needs a little care. One PeerDAS data column contains one cell for each blob in the block. I therefore treated every canonical blob at every observer's first column as one cell position: was the full pooled blob transaction already observed by that same node, or not?

The window was August 3 through August 16. The cohort had eight observers with all 336 hours of blob-mempool capture and data-column observations on all 14 days. Exact canonical block roots left **650,518 node-block pairs** and **3,764,696 node-by-blob positions** after I excluded 186 pairs without an in-slot first-column row.

The reduction was mechanical. I fetched canonical transactions first, queried the mempool in 3,000-hash literal batches, fetched first-column clocks separately, and joined locally. That avoids asking one distributed ClickHouse join to decide which transaction or observer disappeared.

```python
# 1. One canonical row per included blob transaction.
canonical = clickhouse.query("clickhouse-raw", """
SELECT
  slot_start_date_time,
  slot,
  block_root,
  hash,
  `from` AS sender,
  length(blob_hashes) AS blob_count,
  cityHash64(arrayStringConcat(blob_hashes, '|')) AS blob_fp,
  toUInt64(blob_sidecars_size) AS sidecar_bytes
FROM default.canonical_beacon_block_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-08-03 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-17 00:00:00')
  AND type = 3
""")

# 2. This query ran once per day and per 3,000 exact canonical hashes.
mempool_part = clickhouse.query("clickhouse-raw", f"""
SELECT
  hash,
  meta_client_name,
  min(event_date_time) AS first_seen,
  argMin(
    cityHash64(arrayStringConcat(blob_hashes, '|')),
    event_date_time
  ) AS blob_fp,
  argMin(toUInt64(blob_sidecars_size), event_date_time) AS sidecar_bytes
FROM default.mempool_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('{day_start}') - INTERVAL 2 DAY
  AND event_date_time <  toDateTime('{day_end}')
  AND type = 3
  AND coalesce(blob_sidecars_size, 0) > 0
  AND hash IN ({literal_hash_batch})
GROUP BY hash, meta_client_name
""")
mempool_parts.append(mempool_part)
# The loop appends each bounded result to mempool_parts.
mempool = pd.concat(mempool_parts, ignore_index=True)

# 3. Keep the observer key and throw out impossible wrapped/late clocks.
first_columns = clickhouse.query("clickhouse-refined", """
SELECT
  block_root,
  meta_client_name,
  min(seen_slot_start_diff) AS first_col_ms,
  argMin(row_count, seen_slot_start_diff) AS row_count
FROM mainnet.fct_block_data_column_sidecar_first_seen_by_node FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-03 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-17 00:00:00')
  AND seen_slot_start_diff BETWEEN 0 AND 12000
  AND meta_client_name IN ({fixed_observer_literals})
GROUP BY block_root, meta_client_name
""")

pairs = canonical.merge(observers, how="cross")
pairs = pairs.merge(mempool, on=["hash", "meta_client_name"], how="left")
pairs = pairs.merge(first_columns, on=["block_root", "meta_client_name"])

pairs["first_col_time"] = (
    pairs.slot_start_date_time
    + pd.to_timedelta(pairs.first_col_ms, unit="ms")
)
pairs["seen_at_slot_start"] = pairs.first_seen <= pairs.slot_start_date_time
pairs["seen_before_first_col"] = pairs.first_seen <= pairs.first_col_time
```

The slot-start line contains **3,344,260** observed cell positions. The first-column line contains **3,716,024**. That is **371,764** positions added between the two clocks, a 9.87 percentage-point jump.

The result was not carried by one lucky day. Slot-start readiness stayed between 87.25% and 89.94% across all 14 days. First-column readiness stayed between 98.30% and 99.11%. The median first column reached an observer **1,541 ms** after slot start; the median first block observation followed at 1,675 ms.

Whole blocks tell the same story. In **639,229 of 650,518 node-block pairs**, or **98.26%**, every canonical blob had been seen before the observer's first data column. The remaining pairs usually lacked a small, obvious bundle size: one, three, five, or six blobs.

The tail was not random. There were 640 canonical blobs whose transactions reached none of the eight observers before the first column. **360 of them were 60 six-blob transactions from Base's known batch sender**, the same address used in my earlier [Base L1 heartbeat work](/blog/base-safe-head-l1-burst/). That does not prove private order flow. It says this monitored public surface saw a recognizable part of the tail late.

I checked the units and the clocks three ways. The canonical transaction path summed to **470,733 blobs**, exactly matching 470,733 unique `(slot, block_root, blob_index)` rows in `canonical_beacon_blob_sidecar`. Every pre-column mempool match had the exact canonical blob-hash fingerprint and sidecar byte count, and the first-column `row_count` matched the canonical blob count in every retained node-block pair.

I also repeated August 15 and 16 against the lower-level raw `libp2p_gossipsub_data_column_sidecar` path. It returned 98.512% and 98.420% ready before the first column, versus 98.519% and 98.395% through the refined table. The observer surface was smaller on the raw path, but the result moved by less than 0.03 percentage points.

There is still a hard caveat. A `mempool_transaction` event proves that a node saw the full pooled sidecar; it does not prove the execution client retained those bytes until the column arrived. So 98.71% is an upper bound on cells that may have been reusable without a direct residency probe. It is also a monitored eight-node cohort, not an Ethereum-wide census.

EIP-8136 is not live, and this is not a bandwidth benchmark for its partial-message extension. It is a test of the assumption underneath it. On current mainnet, the assumption survives, but only if you use the clock that matters.

The slot boundary is too early. The blob pool is still filling.
