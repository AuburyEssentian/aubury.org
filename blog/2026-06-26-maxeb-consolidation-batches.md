---
slug: maxeb-consolidation-batches
title: MaxEB consolidators stop at 1,920 ETH
description: From May 17 through June 25, 77 MaxEB target validators each absorbed 59 source validators and landed around 1,923 ETH, below the 2,048 ETH cap.
authors: aubury
tags: [ethereum, staking, maxeb, electra, data]
date: 2026-06-26
---

MaxEB made 2,048 ETH validators possible. The first big consolidation batches are not aiming all the way there. They keep landing around **1,920 ETH**, which is sixty old 32 ETH validators packed into one key with some reward dust on top.

<!-- truncate -->

<img src="/img/maxeb-consolidation-batches.png" alt="Horizontal bar chart showing MaxEB consolidation fan-in batches, with 59-source and 47-source batches dominating source validator consumption." loading="eager" />

The new table here is `canonical_beacon_block_execution_request_consolidation`. It is easy to misread because the same request type covers two different operations. When `source_pubkey = target_pubkey`, the Electra state transition treats it as a switch to compounding credentials. When the pubkeys differ, it is a real fan-in consolidation: the source validator exits, and its active balance later moves to the target validator.

So I split those first. Counting both together would smear the shape.

```sql
WITH dedup AS (
  SELECT DISTINCT
    slot,
    block_root,
    position_in_block,
    source_address,
    source_pubkey,
    target_pubkey,
    slot_start_date_time
  FROM canonical_beacon_block_execution_request_consolidation
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-05-07 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-26 00:00:00')
), fan AS (
  SELECT
    target_pubkey,
    uniqExact(source_pubkey) AS incoming_sources
  FROM dedup
  WHERE source_pubkey != target_pubkey
  GROUP BY target_pubkey
)
SELECT
  incoming_sources,
  count() AS targets,
  sum(incoming_sources) AS source_requests
FROM fan
GROUP BY incoming_sources
ORDER BY incoming_sources;
```

That produced **9,201** deduped included consolidation requests through June 25 UTC. **1,161** were switch-to-compounding requests. The other **8,040** were true fan-ins, involving **7,953** source pubkeys and **703** target pubkeys.

The weird part is the fan-in distribution. It is not a smooth spread of operators slowly filling targets to whatever balance they happen to reach. Two batch sizes dominate: **77 target validators absorbed 59 source validators each**, and **50 targets absorbed 47 source validators each**. Those two buckets alone consumed **6,893** of the **8,040** fan-in source requests, or **85.7%** of the fan-in surface.

The 59-source bucket is the one that made me stop. Add the target validator itself and the batch is exactly 60 old validator units. `60 * 32 ETH = 1,920 ETH`. Joining those targets to `mainnet.fct_validator_balance_daily FINAL` on June 25 showed a p50 effective balance of **1,923 ETH**, with the bucket sitting between **1,921** and **1,925 ETH**. The balance check is why I am comfortable treating this as a real consolidation shape, not just an included-request shape.

The same check makes the 47-source bucket look deliberate too. Add the target and it is 48 old validator units, or **1,536 ETH** before rewards. Its June 25 p50 effective balance was **1,539 ETH**.

The balance side was a separate query because the request table is raw and the validator-balance table is refined:

```sql
-- after mapping target_pubkey -> validator_index with mainnet.dim_validator_pubkey
SELECT
  validator_index,
  effective_balance,
  end_balance,
  status
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date = toDate('2026-06-25')
  AND validator_index IN (...target validators...);
```

The source side moved the other way. For fan-in requests in the same window, the June 25 status snapshot had **7,678** source validators at `withdrawal_done`, **176** at `withdrawal_possible`, **53** at `exited_unslashed`, and **45** at `active_exiting`. Only **one** source validator from the deduped fan-in set was still `active_ongoing` in that snapshot. The target side was almost all live: **696** fan-in targets were `active_ongoing`, carrying about **1.038M ETH** of effective balance.

There is a clean protocol reason for the table split. In the Electra spec, `is_valid_switch_to_compounding_request` requires `source_pubkey == target_pubkey`; the fan-in path rejects that equality, checks the source withdrawal credentials, checks that the target already has compounding credentials, initiates the source exit, and appends a pending consolidation. A row in the table is still an included execution-layer request, not a magical instant merge, so the status and balance join is the sanity check.

The part I would not overclaim is motive. The obvious read is that operators want headroom below the **2,048 ETH** MaxEB cap instead of running targets right up against it. Sixty 32 ETH validators leaves about **128 ETH** of room; forty-eight leaves about **512 ETH**. That is enough room for rewards, operational preference, or just a batch size their tooling likes. The data can show the lumpy stop points. It cannot read the runbook sitting behind the withdrawal address.

But it does kill one lazy mental model. MaxEB consolidation is not simply "64 validators become one." On mainnet so far, the dominant live pattern is closer to **60 become one**, with a second large **48 become one** lane. The cap is 2,048 ETH. The operating target, at least for the largest observed batches, is lower.
