---
slug: pending-consolidation-snapshot-trap
title: The pending consolidation queue is not a daily counter
description: "Electra's pending-consolidation table repeats the same queue entries every epoch. On Jul 5 it showed 7,927 snapshot positions while the live queue had seven entries."
authors: aubury
tags: [ethereum, staking, maxeb, electra, data]
date: 2026-07-06
---

The consolidation queue looked busy if I counted it the lazy way. On Jul 5 UTC, `canonical_beacon_state_pending_consolidation` had **7,927** deduped queue-position rows. The latest canonical state snapshot had **seven** pending consolidations.

Same table. Different denominator.

<!-- truncate -->

<img src="/img/pending-consolidation-snapshot-trap.png" alt="Jul 5 pending-consolidation snapshot rows are 7,927 while execution request rows are 14 and the latest live queue has 7 entries" loading="eager" />

This is the same class of trap as the pending-deposit and pending-partial-withdrawal queues, but the consolidation version has its own sharp edge. `canonical_beacon_state_pending_consolidation` is a state snapshot table. It stores the pending queue at an epoch: `position_in_queue`, `source_index`, and `target_index`. If an entry waits across 100 epochs, it can appear 100 times. That does not mean 100 consolidations happened.

Here is the query I used. The important bit is the first CTE: resolve one queue length per epoch before doing anything daily. If you group the raw table by day first, you are measuring the area under the queue, not the queue.

```sql
WITH epoch_q AS (
  SELECT
    toDate(epoch_start_date_time) AS day,
    epoch,
    uniqExact(position_in_queue) AS queue_len
  FROM default.canonical_beacon_state_pending_consolidation
  WHERE meta_network_name = 'mainnet'
    AND epoch_start_date_time >= toDateTime('2026-06-22 00:00:00')
  GROUP BY day, epoch
)
SELECT
  day,
  count() AS epochs_with_queue,
  sum(queue_len) AS snapshot_positions,
  max(queue_len) AS max_queue_len,
  argMax(queue_len, epoch) AS last_queue_len,
  quantile(0.5)(queue_len) AS p50_queue_len,
  quantile(0.95)(queue_len) AS p95_queue_len,
  max(epoch) AS last_epoch
FROM epoch_q
GROUP BY day
ORDER BY day;
```

For the partial Jul 5 UTC day, that returned **7,927** snapshot positions across **178** epochs with queue rows. The median queue length was **50**, the max was **53**, and then the queue drained down to **7** by epoch **459515** at **18:56:23 UTC**. If I had stopped at `count()` by day, I would have reported a number **1,132x** larger than the live queue.

The second cross-check is the request surface. Consolidation requests live in the block execution-request table, not in the pending state table. This query counts included request rows; it still is not the same thing as accepted pending queue entries, because a source=target request is a switch-to-compounding path and invalid requests can be ignored by the state transition. But it is the right neighboring surface for “what arrived on chain today?”

```sql
SELECT
  toDate(slot_start_date_time) AS day,
  count() AS request_rows,
  uniqExact(source_pubkey) AS source_pubkeys,
  uniqExact(target_pubkey) AS target_pubkeys
FROM default.canonical_beacon_block_execution_request_consolidation
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-22 00:00:00')
GROUP BY day
ORDER BY day;
```

That query returned **14** consolidation-request rows on Jul 5 UTC, from **10** source pubkeys to **7** target pubkeys. Across Jun 22 through the latest Jul 5 data, it returned **441** request rows. The snapshot-position sum over the same dates was **210,974**. Those two numbers are both real, but they are not competing answers to the same question.

The latest snapshot makes the mechanism pretty concrete. It had seven positions, seven source validators, and three target validators. Joining the source indices back to the latest raw validator state showed all seven sources were already `exited_unslashed` with 32 ETH effective balance. Their `withdrawable_epoch` values were still in the future, so they stayed in `pending_consolidations` instead of being moved into the target balances yet.

That matches the Electra spec. `PendingConsolidation` is just:

```python
class PendingConsolidation(Container):
    source_index: ValidatorIndex
    target_index: ValidatorIndex
```

`process_consolidation_request` initiates the source validator exit and appends that pair to `state.pending_consolidations`. Later, `process_pending_consolidations` walks the queue and stops when the next source validator is not withdrawable yet. The table is showing that waiting room, sampled once per epoch.

So the safe nouns are boring but important:

- **request rows**: consolidation requests included in beacon blocks;
- **snapshot positions**: queue entries repeated across canonical state snapshots;
- **latest queue positions**: the pending queue at one chosen epoch.

On Jul 5, those were **14**, **7,927**, and **7**. If a dashboard says "pending consolidations today" and uses the middle number, it is not measuring consolidations. It is measuring how long the queue stayed non-empty.
