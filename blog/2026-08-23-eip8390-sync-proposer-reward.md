---
slug: eip8390-sync-proposer-reward
title: "EIP-8390 forgot the proposer reward"
description: "Draft EIP-8390 says removing the sync committee cuts 33,800 ETH of annual issuance. The block proposer is paid from the same function; 14 days of mainnet rewards annualize to 37,506 ETH."
authors: aubury
tags: [ethereum, sync-committee, rewards, issuance, eip-8390, data]
date: 2026-08-23
---

The draft I called EIP-9999 [six hours ago](/blog/eip9999-sync-committee-denominator/) now has a real number: [EIP-8390](https://github.com/ethereum/EIPs/pull/12228). It says deleting the sync committee would cut consensus issuance by `2/64`, about **33,800 ETH a year**.

I followed the function it deletes. There is another mint inside it.

<!-- truncate -->

<img src="/img/eip8390-sync-proposer-reward.png" alt="EIP-8390 says removing the sync committee cuts 33,800 ETH per year, while the current-state reward formula gives 38,616 ETH and 14 observed mainnet days annualize to 37,506 ETH after adding block-proposer rewards" loading="eager" />

The draft's number is the committee-member side of the reward. In [`process_sync_aggregate`](https://github.com/ethereum/consensus-specs/blob/34d86966f4c7e2aeacc66249bc814ef6ad6efdbd/specs/altair/beacon-chain.md#sync-aggregate-processing), every successful sync bit also pays the block proposer. The current formula is `proposer_reward = participant_reward * 8 // (64 - 8)`, so the proposer gets almost one seventh as much as the member for each successful position.

That proposer payment disappears with the function too. The `2/64` weight describes the member pot, not every balance increase made while processing the sync aggregate. Before integer floors, the full-participation arithmetic is `2/64 × (1 + 8/56) = 2/56 = 1/28` of the base-reward pool.

I first froze the active state at the end of August 22. Both the refined daily snapshot and the exact raw state at epoch **470,359** returned **901,459 active indices** and **42,335,384 effective ETH**. The raw state had 2,344,217 rows and the same number of unique validator indices.

```sql
SELECT
  countIf(status LIKE 'active%') AS active_indices,
  sumIf(toUInt128(effective_balance), status LIKE 'active%')
    AS active_effective_gwei
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date = toDate('2026-08-22')
```

At that stake, the exact integer formula pays **25,112 gwei** to each committee position and **3,587 gwei** to the proposer for each successful bit. If every physical slot had a block and all 512 positions signed, that annualizes to **33,789 ETH** for committee members plus **4,826 ETH** for proposers: **38,616 ETH**, 14.25% above the draft's 33,800 ETH estimate.

The chain is messier than an all-slots calculation, so I checked the actual reward rows across the 14 complete UTC days from August 9 through August 22. I queried the member and proposer streams separately, then joined the daily aggregates locally rather than trusting a distributed cross-table join.

```sql
-- Committee-member rewards and penalties
SELECT
  toDate(slot_start_date_time) AS day,
  count() AS row_count,
  uniqExact((slot, block_root, validator_index)) AS semantic_rows,
  uniqExact((slot, block_root)) AS blocks,
  sum(reward) AS participant_net_gwei,
  sumIf(reward, reward > 0) AS participant_positive_gwei,
  sumIf(reward, reward < 0) AS participant_penalty_gwei,
  countIf(reward > 0) AS positive_rows,
  countIf(reward < 0) AS penalty_rows
FROM default.canonical_beacon_sync_committee_reward FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-08-09 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-23 00:00:00')
GROUP BY day
ORDER BY day
```

```sql
-- The proposer payment created by those same successful bits
SELECT
  toDate(slot_start_date_time) AS day,
  count() AS block_reward_rows,
  uniqExact((slot, block_root)) AS semantic_blocks,
  sum(sync_aggregate) AS sync_proposer_gwei,
  sum(total) - (
    sum(attestations) + sum(sync_aggregate) +
    sum(proposer_slashings) + sum(attester_slashings)
  ) AS unexplained_gwei
FROM default.canonical_beacon_block_reward FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-08-09 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-23 00:00:00')
GROUP BY day
ORDER BY day
```

The window contained **100,437 canonical blocks** and **51,423,744 member rows**. Every member row had a unique `(slot, block_root, validator_index)` key; daily block counts matched the block-reward table; positive and negative reward-row counts matched `validators_participated` and `validators_missed` from the canonical sync aggregates. The block-reward components also summed back to `total` with zero unexplained gwei on every day.

Members received **1,271.531 ETH** and paid **14.561 ETH** in missed-bit penalties, leaving **1,256.970 ETH net**. Block proposers received another **181.626 ETH** from the sync aggregates. Removing the whole function would therefore have reduced net issuance by **1,438.597 ETH** over the window, which annualizes to **37,506 ETH**.

That is **3,706 ETH a year**, or **10.97%**, above the number in the draft. The observed result lands below the 38,616 ETH all-slots formula because only canonical blocks pay the stream and bit participation was 98.868% in this window. Removing the process would also remove missed-bit penalties, so the net supply cut is smaller than the 37,886 ETH gross reward stream.

This is a current-rule backcast, not a forecast of an EIP-8390 fork. Stake will move, missed slots will happen, and deleting the sync committee would change more than validator balances. The draft is also an open PR at head `c2bdb271f1856008fac76d19d8ee48c7ab260688`; it is not merged, scheduled, or live.

The draft can call **33,800 ETH** the committee-member pot. It cannot call that number the issuance removed by deleting `process_sync_aggregate`.
