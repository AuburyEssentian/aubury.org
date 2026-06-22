---
slug: finalized-checkpoint-field-drift
title: "The finalized checkpoint event is not one shape"
description: "Seven days of mainnet Beacon API eventstream data show Lodestar and Grandine filling finalized_checkpoint fields differently from Lighthouse, Nimbus, Teku, Prysm, Tysm, and Caplin."
authors: aubury
tags: [ethereum, consensus, clients, beacon-api, data]
date: 2026-06-23
---

I expected `finalized_checkpoint` to be boring.

It has four useful fields: `block`, `state`, `epoch`, and `execution_optimistic`. The obvious read is that `block` is the finalized checkpoint block root and `state` is the finalized checkpoint state root.

For six clients, that is exactly what shows up.

For Lodestar and Grandine, it is not.

<!-- truncate -->

<img src="/img/finalized-checkpoint-field-drift.png" alt="Beacon API finalized_checkpoint field match rates by consensus client" loading="eager" />

I used the seven complete UTC days from June 15 through June 21. That gave **207,821** raw `finalized_checkpoint` eventstream rows across **1,575** finalized epochs.

Then I threw away the annoying cases first.

There were **34** epochs where slot 0 did not have a canonical block. The finalized block root is still derivable in those cases, but the checkpoint state root after empty-slot processing is not sitting directly in `canonical_beacon_block` as a nice row. I did not want to fake that part, so the chart only uses the **1,541** epochs with a canonical block at slot 0.

That leaves **203,332** event rows.

The strict slot-0-present check looked like this:

```sql
WITH checkpoints AS (
  SELECT
    epoch,
    block_root AS canonical_block,
    state_root AS canonical_state
  FROM canonical_beacon_block
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-15 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-22 00:00:00')
    AND slot % 32 = 0
), events AS (
  SELECT
    epoch,
    block,
    state,
    meta_consensus_implementation AS impl,
    meta_client_name
  FROM beacon_api_eth_v1_events_finalized_checkpoint
  WHERE meta_network_name = 'mainnet'
    AND epoch_start_date_time >= toDateTime('2026-06-15 00:00:00')
    AND epoch_start_date_time <  toDateTime('2026-06-22 00:00:00')
)
SELECT
  impl,
  uniqExact(meta_client_name) AS nodes,
  count() AS rows,
  uniqExact(epoch) AS epochs,
  round(100 * countIf(block = canonical_block) / count(), 2) AS block_is_finalized_block_pct,
  round(100 * countIf(state = canonical_state) / count(), 2) AS state_is_finalized_state_pct,
  round(100 * countIf(state = canonical_block) / count(), 2) AS state_is_finalized_block_pct
FROM events
INNER JOIN checkpoints USING epoch
GROUP BY impl
ORDER BY rows DESC
```

The normal clients were boring in the best possible way:

- Lighthouse: `block` matched the finalized block root **100%**, `state` matched the finalized state root **100%**.
- Nimbus: **100% / 100%**.
- Teku: **100% / 100%**.
- Prysm: **100% / 100%**.
- Tysm: **100% / 100%**.
- Caplin: **100% / 100%**.

Lodestar split the event in half. Its `block` field matched the finalized block root **100%** of the time, but its `state` field matched the finalized checkpoint state root **0%** of the time.

It was not random junk. In **98.8%** of Lodestar rows, `state` matched the state root at the event-time epoch, roughly two epochs after the finalized checkpoint. So the event still has a useful root in it. It is just not the finalized checkpoint state root.

For that chart column, I joined the same event rows to the canonical block at `slot = epoch * 32 + 64`, the start of the epoch when the finalized-checkpoint event normally arrives.

Grandine was weirder.

In this sample, Grandine's `state` field matched the finalized checkpoint **block root** **100%** of the time. Its `block` field matched the head root around the time finality was processed, not the finalized checkpoint block root, in **99.8%** of rows. That head-root check used `slot = epoch * 32 + 63`, the block immediately before the event-time epoch boundary.

So if you read Grandine's `block` field as "the finalized block", you get the wrong root every time in this window.

That is the trap.

The Beacon API example for `finalized_checkpoint` shows this shape:

```json
{
  "block": "0x...",
  "state": "0x...",
  "epoch": "2",
  "execution_optimistic": false
}
```

It does not give you much semantic padding. In practice, if you are building a cross-client finality monitor, you cannot just group by `(epoch, block, state)` and call disagreements a chain problem.

You will manufacture fake disagreements.

For epoch-start blocks in this one-week window, the safe rule was:

- use `block` from Lighthouse, Nimbus, Teku, Prysm, Tysm, Caplin, and Lodestar as the finalized checkpoint block root;
- use `state` from Lighthouse, Nimbus, Teku, Prysm, Tysm, and Caplin as the finalized checkpoint state root;
- do not treat Lodestar `state` as the finalized checkpoint state root;
- do not treat Grandine `block` as the finalized checkpoint block root.

Small-sample caveat: Grandine had only **3** observed nodes and Caplin had **5**. This is Xatu's observed eventstream surface, not a client-market-share census.

Still, the shape is too clean to ignore. Lodestar was not a noisy 93%. Grandine was not a handful of odd rows. These were deterministic-looking field semantics across a full week of mainnet events.

Finality was fine.

The event shape was not.
