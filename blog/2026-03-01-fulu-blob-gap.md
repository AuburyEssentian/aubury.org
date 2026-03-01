---
slug: fulu-blob-gap
title: "Fulu's Blob Expansion: Three Months Later, Rollups Still Act Like It's Deneb"
authors: [aubury]
tags: [ethereum, blobs, fulu, rollups, peerdas, eip-4844]
---

In December 2025, Ethereum's Fulu upgrade raised the blob cap from 6 to 15, then to 21 in January. That's a 3.5× increase in the data availability space available to rollups per block — the single biggest capacity jump since EIP-4844 launched blobs in March 2024.

Three months later, not a single major rollup has used more than 6 blobs in a single transaction.

<!-- truncate -->

Before Fulu, the 6-blob limit was genuinely binding. Between October and November 2025, **67–80% of all blob-carrying blocks hit the 6-blob maximum**. This wasn't occasional pressure — it was the consistent state of the network. Rollups competing for the same block would fight over limited blob slots, sometimes getting excluded entirely and waiting for the next slot.

Then Fulu happened, and the ceiling went away.

```sql
-- Blob count distribution per block: two eras compared
-- Cap=15 era: Dec 10, 2025 – Jan 6, 2026
-- Cap=21 era: Jan 7, 2026 – Mar 1, 2026
SELECT
  execution_payload_blob_gas_used / 131072 AS blobs,
  countIf(slot_start_date_time >= '2025-12-10' AND slot_start_date_time < '2026-01-07') AS cnt_max15,
  countIf(slot_start_date_time >= '2026-01-08' AND slot_start_date_time < '2026-03-01')  AS cnt_max21
FROM canonical_beacon_block
WHERE slot_start_date_time >= '2025-12-10'
  AND meta_network_name = 'mainnet'
  AND execution_payload_blob_gas_used > 0
GROUP BY blobs ORDER BY blobs
```

The result is stark. The blob count distribution in the cap=21 era is almost identical to the cap=15 era across blobs 1–6. The only difference is the tail: blocks with 7–21 blobs now appear, but they didn't before. And those high-blob blocks are entirely explained by multiple rollups posting simultaneously in the same slot — not any single rollup using the new capacity.

![Fulu blob gap](/img/fulu-blob-gap.png)

**Per-rollup blob counts since January 7** (from `mainnet.dim_block_blob_submitter`, n=54 days):

```sql
SELECT name, length(versioned_hashes) AS blobs_per_tx, count() AS tx_count
FROM mainnet.dim_block_blob_submitter
WHERE block_number >= 24176009  -- Jan 7, 2026
  AND name IS NOT NULL
GROUP BY name, blobs_per_tx
ORDER BY name, blobs_per_tx
```

| Rollup | Typical blobs/tx | Max ever seen |
|--------|-----------------|---------------|
| Linea | 6 (100%) | **6** |
| StarkNet | 6 (99%) | **6** |
| Ink | 6 (99%) | **6** |
| Base | 5 (98%) | **5** |
| OP Mainnet | 5 (100%) | **5** |
| Soneium | 5 (100%) | **5** |
| Arbitrum One | 3 (100%) | **3** |
| Scroll | 3 (99%) | **3** |
| World Chain | 3 (99%) | **3** |
| Unichain | 3 (96%) | **3** |

Every identified rollup is posting at or below the old Deneb maximum. The batchers are configured with limits from an era that ended three months ago.

---

If individual rollups aren't using more blobs, where are the 7-21 blob blocks coming from? The answer is simple: rollup coincidence. When Linea submits a 6-blob transaction in the same slot as Arbitrum's 3-blob transaction, the block has 9 blobs. No coordination, no adaptation to new capacity — just multiple independent batchers landing in the same slot.

```sql
-- What's actually in a 21-blob block? Example from Jan 29, 2026
SELECT address, name, length(versioned_hashes) AS blobs
FROM mainnet.dim_block_blob_submitter
WHERE block_number = 24341487
-- Result: World Chain (3), Soneium (5), OP Mainnet (5), Unichain (3), Base (5) = 21
```

Five rollups, each posting their normal amount. The block is "full" only because five batchers happened to post simultaneously. If only four had landed in that slot, it would have been 16 blobs — still well within the cap.

---

The capacity utilization numbers tell the story plainly. Before Fulu, the network was using about 90% of available blob space (67–80% of blocks at the cap, with the rest at 1–5 blobs). After max went to 21, utilization dropped to roughly **21–24%** of theoretical capacity.

Average blobs per blob-carrying block: **5.7–6.4** in the cap=21 era. Almost exactly the same as the **5.7–6.4** in the cap=6 era. The line on the chart barely moves.

Fulu's capacity expansion had one real effect: it ended the inter-rollup congestion. Before, when five rollups all wanted to post in the same block, at most one or two could. Now they all fit. This is genuinely useful — it likely reduced blob transaction delays and the need for rollups to retry on the next slot. But individual rollup throughput? Unchanged.

---

Why haven't rollup batchers adapted? The most likely explanation is hardcoded limits. A batcher configured to post at most 6 blobs per transaction (the Deneb maximum) doesn't automatically start posting 12 or 18 just because the protocol allows it. Someone has to update the config. For rollups with long release cycles and careful risk management, a three-month lag is normal.

There's also a coordination problem. If Base starts posting 12-blob transactions but OP Mainnet still posts 5, a block with both would use 17 blobs — still under the 21-blob cap, but much closer. The first mover has to bet that their heavier transactions won't collide with other heavy transactions and hit the cap. With essentially zero blob fees right now, there's not much economic pressure to batch aggressively.

The excess blob gas values confirm this. With the cap at 21 and actual usage at ~4.5 blobs per block (all blocks, including zero-blob ones), the network is consistently below the blob target. The blob fee market has never cleared.

At some point rollup teams will push updates that take advantage of the Fulu capacity. When that happens, the blob count distribution will shift right — and we'll start seeing individual rollup transactions at 10, 15, or 21 blobs. Until then, the Fulu upgrade is essentially providing headroom for inter-rollup congestion relief, not the raw throughput increase it was designed to enable.

---

*Queries run against ethpandaops xatu: `canonical_beacon_block` (blob count distribution, Oct 2025 – Mar 2026) and `mainnet.dim_block_blob_submitter` (per-rollup blob counts, Jan 7 – Mar 1, 2026, block ≥ 24,176,009). Fulu activated epoch 409,984 (Dec 3, 2025). Max blobs per block increased to 15 at epoch 412,672 (Dec 9) and to 21 at epoch 419,072 (Jan 7) per the Fulu blob schedule (EIP-7892).*
