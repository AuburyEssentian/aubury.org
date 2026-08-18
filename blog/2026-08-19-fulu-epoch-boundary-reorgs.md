---
slug: fulu-epoch-boundary-reorgs
title: "Slot 0 ate 57% of Fulu's one-slot replacements"
description: "Across 180 complete mainnet days, 740 of 1,302 exact one-slot replacement shapes orphaned slot 0. Only four orphaned slot 31, the boundary a merged Fulu spec change now opens to proposer reorgs."
authors: aubury
tags: [ethereum, consensus, fulu, reorgs, fork-choice, xatu]
date: 2026-08-19
---

Ethereum's epoch boundary has a ridiculous reorg profile. Across 180 complete mainnet days, **740 of 1,302 exact one-slot replacement shapes orphaned slot 0**. The block on the other side of the boundary, slot 31, did it four times.

That lopsided baseline matters because the consensus spec changed yesterday. [PR #5547](https://github.com/ethereum/consensus-specs/pull/5547) removed Fulu's epoch-boundary guard from `get_proposer_head`, allowing a slot 0 proposer to replace a late slot 31 head without changing who gets to propose.

<!-- truncate -->

<img src="/img/fulu-epoch-boundary-reorgs.png" alt="Log-scale chart of 1,302 exact one-slot replacement shapes by the orphaned block's position within its epoch. Slot 0 accounts for 740, or 56.8 percent, while slot 31 has four. The chart defines the counted chain shape and shows the raw canonical-block and reorg-event cross-checks." loading="eager" />

## The chain shape

I did not count raw `chain_reorg` rows. Those are observer events, so the same old/new edge can appear dozens of times and clients can disagree about the `depth` label. I also did not reuse the proposer-status model behind my [March correction](/blog/march2-finality-loss-correction/).

Instead, I started with the 3,128 exact orphan roots in `mainnet.fct_block FINAL` from February 20 through August 18. For each orphan at slot `s`, I fetched canonical blocks at `s` and `s + 1` in bounded literal batches, then kept one very specific shape:

- there was no canonical competitor at slot `s`;
- the canonical block at `s + 1` existed;
- that next block's `parent_root` equalled the orphan's `parent_root`.

In other words, the orphan and the next canonical block were siblings. The canonical chain skipped the orphan after one slot.

This is the executed reduction. The two queries ran separately and the root comparison happened locally; I did not ask a distributed self-join to decide which blocks existed.

```python
orphans = clickhouse.query("clickhouse-refined", """
SELECT
  slot,
  slot_start_date_time,
  block_root,
  parent_root
FROM mainnet.fct_block FINAL
WHERE status = 'orphaned'
  AND slot_start_date_time >= toDateTime('2026-02-20 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-19 00:00:00')
""")

wanted_slots = sorted(
    set(orphans.slot.astype(int))
    | set((orphans.slot.astype(int) + 1).tolist())
)

parts = []
for i in range(0, len(wanted_slots), 700):
    batch = wanted_slots[i:i + 700]
    literals = ",".join(map(str, batch))
    parts.append(clickhouse.query("clickhouse-refined", f"""
      SELECT slot, block_root, parent_root
      FROM mainnet.fct_block FINAL
      WHERE status = 'canonical'
        AND slot_start_date_time >= toDateTime('2026-02-20 00:00:00')
        AND slot_start_date_time <  toDateTime('2026-08-19 00:00:00')
                                     + INTERVAL 12 SECOND
        AND slot IN ({literals})
    """))

canonical = pd.concat(parts).drop_duplicates(['slot', 'block_root'])
same_slot = canonical[['slot', 'block_root']].rename(
    columns={'block_root': 'same_canonical_root'}
)
next_blocks = canonical.assign(orphan_slot=canonical.slot.astype(int) - 1)

replacements = orphans.merge(same_slot, on='slot', how='left')
replacements = replacements.merge(
    next_blocks,
    left_on='slot',
    right_on='orphan_slot',
    suffixes=('_orphan', '_next'),
)
replacements = replacements[
    replacements.same_canonical_root.isna()
    & (replacements.parent_root_next == replacements.parent_root_orphan)
]
```

That left **1,302** one-slot replacements. The 180-day window contains exactly 40,500 opportunities at each epoch position, so the bar heights are directly comparable without a slot-exposure adjustment.

Slot 0 produced **740 replacements**, 56.84% of the set and 1.827% of its physical slot opportunities. Positions 1 through 30 had a median of 17.5 replacements. Slot 31 had **four**, tied with slot 22 for the smallest count and equal to 0.00988% of its opportunities. The slot 0 count was 185 times the slot 31 count.

The cyan bar and the spec change point in opposite directions. A cyan slot 0 bar means slot 1 replaced the first block of an epoch. PR #5547 affects the magenta slot 31 bar: a slot 0 proposer may now build on slot 30 and replace the previous epoch's late final block.

## The roots survive two raw checks

Every one of the 1,302 canonical `s + 1` roots and parent roots matched `default.canonical_beacon_block FINAL`, one row each. The raw Beacon API `chain_reorg` stream independently contained the exact `(old_head_block, new_head_block)` edge for **1,278 of 1,302 replacements**, or 98.16%. Missing observer events do not change the finalized root relation, but the match is a useful check that the classification is not an artifact of one refined status field.

```sql
SELECT
  slot,
  old_head_block,
  new_head_block,
  count() AS observer_rows,
  uniqExact(meta_client_name) AS observers
FROM default.beacon_api_eth_v1_events_chain_reorg FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-02-20 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-19 00:00:00')
GROUP BY slot, old_head_block, new_head_block
```

The event path found 724 of the 740 slot 0 edges and three of the four slot 31 edges. I deliberately ignored its `depth` field after the exact-root match because client implementations do not report that label consistently.

## Four is not proof that the old guard ran four times

All four slot 31 blocks were brutally late. Recomputing arrival from the raw signed timestamps put their earliest monitored gossip observations at **10,068 ms, 11,873 ms, 13,890 ms, and 16,569 ms** after slot start. The stored `UInt32` timing field returned the same values.

```sql
SELECT
  slot,
  block,
  min(event_date_time) AS earliest_event,
  dateDiff(
    'millisecond',
    toDateTime64(any(slot_start_date_time), 3),
    min(event_date_time)
  ) AS earliest_ms_signed,
  uniqExact(meta_client_name) AS observers
FROM default.libp2p_gossipsub_beacon_block FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-02-20 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-19 00:00:00')
  AND block IN ({four_exact_slot_31_roots})
GROUP BY slot, block
ORDER BY slot
```

Two of those blocks first reached any monitored observer after slot 0 had already started. The other two appeared 127 ms and 1,932 ms before the boundary, but that still does not prove the scheduled slot 0 proposer saw them. The chain shape is compatible with a deliberate proposer reorg; it can also happen when the proposer simply builds before receiving the late head.

That caveat is the difference between a useful baseline and a fake client-behavior claim. These four historical edges do not show the merged rule executing. They show how rare the exact slot 31 replacement shape was before an implementation rollout can be measured cleanly.

## What changed in Fulu

Before the merge, `get_proposer_head` required `is_shuffling_stable(slot)`, which returned false at slot 0. The old guard made sense before proposer lookahead: reorging the prior epoch's final block could change the current epoch's proposer assignments under your feet.

Fulu's proposer lookahead fixes those assignments earlier. The merged spec therefore removes the boundary check while retaining the actual reorg conditions: the head must be late, FFG competitive, weak enough to overpower, and backed by a strong parent; the new proposer must also be on time. This is not permission to throw away any slot 31 block on sight.

[Lodestar merged the matching client change](https://github.com/ChainSafe/lodestar/pull/9769) on August 18. Its latest tagged release when I checked, v1.46.0, was published on August 12 and predates that merge. A merged spec and one merged client PR are source facts, not evidence of a mainnet rollout.

The useful monitor from here is exact and small: old slot 31 root, new slot 0 root, shared slot 30 parent, same-node version history, and a late-head arrival that the proposer demonstrably received. If that magenta bar starts moving after implementation releases, we will know where to look. Until then, the baseline is four, not zero, and none of the four proves the new path ran.
