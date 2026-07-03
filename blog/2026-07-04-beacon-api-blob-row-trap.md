---
slug: beacon-api-blob-row-trap
title: "The Beacon API blob table is not a blob counter"
description: "From Jun 26 through Jul 2, Xatu's mainnet beacon_api_eth_v1_beacon_blob table had 5.56M rows for 187,031 canonical blobs. After dedupe, the only API-only blob keys were orphaned block roots."
authors: [aubury]
tags: [ethereum, blobs, beacon-api, xatu, data]
date: 2026-07-04
---

`beacon_api_eth_v1_beacon_blob` looks like a blob table until you count it. Across the seven complete UTC days from Jun 26 through Jul 2, it had **5,557,049 rows**. The canonical chain had **187,031 blobs** in the same window.

That was not a hidden 30x blob burst. It was the same blob commitments being observed over and over by Xatu's Beacon API sentries.

<!-- truncate -->

<img src="/img/beacon-api-blob-row-trap.png" alt="Dark two-panel chart showing that beacon_api_eth_v1_beacon_blob had about 29.7 raw rows per canonical blob, while the deduped API-only tail was 305 blob keys across orphaned block roots." loading="eager" />

The schema comment gives the game away: this table contains blob metadata "from each sentry client attached to a beacon node." That makes it an observation surface. If thirty sentries see the same block root and blob commitment, row count moves by about thirty, not by one.

Here is the raw side of the check I ran first. It keeps the API-derived rows next to the canonical blob sidecar table and uses the same dedupe key for both surfaces: slot, block root, blob index, and versioned hash.

```sql
-- clickhouse-raw
WITH api AS (
  SELECT
    toDate(slot_start_date_time) AS day,
    count() AS api_rows,
    uniqExact(tuple(slot, block_root, blob_index, versioned_hash)) AS api_unique_blob_keys,
    uniqExact(meta_client_name) AS api_sentries,
    uniqExact(slot) AS api_slots
  FROM default.beacon_api_eth_v1_beacon_blob
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-26 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-03 00:00:00')
  GROUP BY day
), canonical AS (
  SELECT
    toDate(slot_start_date_time) AS day,
    count() AS canonical_sidecars,
    uniqExact(tuple(slot, block_root, blob_index, versioned_hash)) AS canonical_unique_blob_keys,
    uniqExact(slot) AS canonical_slots,
    sum(blob_size - blob_empty_size) AS canonical_payload_bytes
  FROM default.canonical_beacon_blob_sidecar
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-26 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-03 00:00:00')
  GROUP BY day
)
SELECT
  api.day,
  api_rows,
  api_unique_blob_keys,
  api_sentries,
  canonical_sidecars,
  canonical_unique_blob_keys,
  round(api_rows / canonical_sidecars, 2) AS rows_per_canonical_blob,
  round(canonical_payload_bytes / 1e9, 3) AS canonical_payload_gb
FROM api
INNER JOIN canonical USING day
ORDER BY day;
```

The shape was boring in the best possible way: stable, repeatable, and obviously not a chain-count metric.

| day | API rows | canonical blobs | rows per canonical blob | deduped API-only keys |
| --- | ---: | ---: | ---: | ---: |
| 2026-06-26 | 886,371 | 28,572 | 31.02x | 31 |
| 2026-06-27 | 678,683 | 22,078 | 30.74x | 38 |
| 2026-06-28 | 651,492 | 21,722 | 29.99x | 26 |
| 2026-06-29 | 1,104,634 | 37,035 | 29.83x | 118 |
| 2026-06-30 | 725,719 | 24,893 | 29.15x | 19 |
| 2026-07-01 | 733,305 | 25,466 | 28.80x | 55 |
| 2026-07-02 | 776,845 | 27,265 | 28.49x | 18 |

The canonical sidecar count also matched the refined daily aggregate exactly:

```sql
-- clickhouse-refined
SELECT
  day_start_date AS day,
  total_blobs
FROM mainnet.fct_blob_count_daily FINAL
WHERE day_start_date >= toDate('2026-06-26')
  AND day_start_date <  toDate('2026-07-03')
ORDER BY day;
```

That returned the same **187,031** blobs as `canonical_beacon_blob_sidecar`. The API table's **5.56M** raw rows were real rows, but they were not real unique blobs.

The more interesting bit was what survived after dedupe. I expected the API table to collapse perfectly onto the canonical sidecar set. It almost did, but not quite: **305 API-only blob keys** remained, spread across **44 block roots**. I used a local anti-join for that part so I did not make a giant distributed join do too much clever work.

```python
from ethpandaops import clickhouse
import pandas as pd

START = '2026-06-26 00:00:00'
END = '2026-07-03 00:00:00'

api_u = clickhouse.query('clickhouse-raw', f"""
SELECT
  toDate(slot_start_date_time) AS day,
  slot,
  block_root,
  blob_index,
  versioned_hash
FROM default.beacon_api_eth_v1_beacon_blob
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('{START}')
  AND slot_start_date_time <  toDateTime('{END}')
GROUP BY day, slot, block_root, blob_index, versioned_hash
""")

can_u = clickhouse.query('clickhouse-raw', f"""
SELECT
  toDate(slot_start_date_time) AS day,
  slot,
  block_root,
  blob_index,
  versioned_hash
FROM default.canonical_beacon_blob_sidecar
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('{START}')
  AND slot_start_date_time <  toDateTime('{END}')
GROUP BY day, slot, block_root, blob_index, versioned_hash
""")

keys = ['day', 'slot', 'block_root', 'blob_index', 'versioned_hash']
extra = api_u.merge(can_u[keys], on=keys, how='left', indicator=True)
extra = extra[extra['_merge'] == 'left_only'].copy()

slots = sorted(map(int, extra['slot'].unique()))
status_chunks = []
for i in range(0, len(slots), 500):
    slot_list = ','.join(map(str, slots[i:i + 500]))
    status_chunks.append(clickhouse.query('clickhouse-refined', f"""
    SELECT
      slot,
      block_root,
      status
    FROM mainnet.fct_block_proposer_by_validator FINAL
    WHERE slot_start_date_time >= toDateTime('{START}')
      AND slot_start_date_time <  toDateTime('{END}')
      AND slot IN ({slot_list})
    """))

status = pd.concat(status_chunks, ignore_index=True)
extra_status = extra.merge(status, on=['slot', 'block_root'], how='left')
print(extra_status.groupby(['day', 'status'], dropna=False).size())
```

Every one of those 305 API-only keys joined to `status = 'orphaned'` in `mainnet.fct_block_proposer_by_validator FINAL`. That is the part I would not have guessed from the table name alone. The Beacon API blob table was not merely repeating canonical blobs across observers; it also retained a tiny tail of blob commitments attached to noncanonical block roots.

That does not make the table bad. It makes it specific. If the question is "what did these Beacon API sentries emit?", `beacon_api_eth_v1_beacon_blob` is the right kind of table. If the question is "how many blobs landed on Ethereum?", raw row count is the wrong unit, and even deduped API keys need a canonical-status check.

The safe habit is simple: count canonical blobs from `canonical_beacon_blob_sidecar` or `mainnet.fct_blob_count_daily FINAL`, and use the Beacon API table when you actually want observer behavior. Otherwise a seven-day window with **187,031 canonical blobs** turns into **5,557,049 blob-looking rows**, plus a small orphaned tail, and the dashboard looks haunted for no good reason.
