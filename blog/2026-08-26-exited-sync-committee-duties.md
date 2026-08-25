---
slug: exited-sync-committee-duties
title: "Exit is not the end of sync duty"
description: "A new Prysm fix sent me back to Mainnet: 92 sync-committee memberships survived validator exit, and 11 of them missed at least 90% of their remaining work."
authors: aubury
tags: [ethereum, consensus, sync-committee, prysm, xatu]
date: 2026-08-26
---

Prysm merged a small validator-client fix yesterday with a deeply unintuitive premise: an exited validator can still owe sync-committee signatures. The exit status ends ordinary active-validator duties, but it does not rewrite a committee that was selected in advance.

I checked 90 recent Mainnet committee periods. Ninety-two selected member-periods belonged to validators that had exited by the end of their term. Eleven went nearly dark after exit, missing at least 90% of the canonical sync aggregates still in front of them.

<!-- truncate -->

## A committee can outlive the validator

The state carries both a current and a next sync committee. At each 256-epoch boundary, the next committee becomes current and another one is chosen ahead of time. A validator can therefore exit after selection but before the term starts, or exit halfway through an active term. Either way, its pubkey remains in that fixed committee until the next boundary.

This is the awkward edge behind [Prysm issue #16759](https://github.com/OffchainLabs/prysm/issues/16759). On the Beacon REST path, the validator client fetched duties for active keys and could drop an exited key even when that key was still in the current sync committee. [PR #17395](https://github.com/OffchainLabs/prysm/pull/17395), merged into `develop` on August 25, adds those exited committee keys back and keeps their last valid duty epoch aligned with the committee period.

The fix is not in a tagged Prysm release at my cutoff. The chain data below also has no validator-to-client label or REST-mode flag. It can measure the shape of the problem, but it cannot pin any bad row on Prysm.

## Ninety-two memberships survived exit

I took committee periods 1750 through 1839 from `canonical_beacon_sync_committee`. The table has one row per period, with the 512 positions nested in `validator_aggregates`. After flattening those arrays locally, I fetched the latest lifecycle row for each selected index from `mainnet.dim_validator_status FINAL` in literal batches and kept a member-period when `exit_epoch <= period_end_epoch`.

This was the selection query. The later status fetch used the exact index list produced here rather than a distributed subquery:

```sql
SELECT
  sync_committee_period,
  epoch,
  validator_aggregates
FROM default.canonical_beacon_sync_committee FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch_start_date_time >= now() - INTERVAL 120 DAY
  AND sync_committee_period >= (
    SELECT max(sync_committee_period) - 89
    FROM default.canonical_beacon_sync_committee FINAL
    WHERE meta_network_name = 'mainnet'
      AND epoch_start_date_time >= now() - INTERVAL 120 DAY
  )
ORDER BY sync_committee_period
```

That produced 46,080 committee positions across 90 periods. Ninety-two positions, held by 91 distinct validators, had an exit epoch no later than the end of the active term. Exactly half exited during the term; the other 46 exited after selection but before the term began. I checked all 91 exit epochs and current statuses against a separate finalized [public Beacon API](https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/states/finalized/validators/1832296), with no mismatches.

For participation, I generated an exact `multiIf` mapping from `(validator_index, committee_period)` to `exit_slot`. This is the executed query shape; `conditions` and `ids` came from the frozen candidate list above:

```python
conditions = ",\n".join(
    f"(validator_index = {c['validator_index']} "
    f"AND intDiv(slot, 8192) = {c['committee_period']}), "
    f"toUInt64({c['exit_epoch'] * 32})"
    for c in candidates
)
ids = ",".join(str(v) for v in sorted({c["validator_index"] for c in candidates}))

participation = clickhouse.query("clickhouse-refined", f"""
SELECT
  intDiv(slot, 8192) AS committee_period,
  validator_index,
  count() AS canonical_block_rows,
  countIf(slot < candidate_exit_slot) AS pre_exit_rows,
  countIf(slot < candidate_exit_slot AND NOT participated) AS pre_exit_missed,
  countIf(slot >= candidate_exit_slot) AS post_exit_rows,
  countIf(slot >= candidate_exit_slot AND NOT participated) AS post_exit_missed
FROM (
  SELECT
    slot,
    validator_index,
    participated,
    multiIf({conditions}, toUInt64(0)) AS candidate_exit_slot
  FROM mainnet.fct_sync_committee_participation_by_validator FINAL
  WHERE slot BETWEEN 14336000 AND 15071615
    AND validator_index IN ({ids})
)
WHERE candidate_exit_slot > 0
GROUP BY committee_period, validator_index
ORDER BY committee_period, validator_index
""")
```

That denominator matters. A failure-only `ARRAY JOIN validators_missed` is how I previously [divided misses by misses](/blog/sync-committee-ghost-query-correction/). Here, each row is one selected validator on one canonical block aggregate. A skipped proposal has no canonical aggregate to inspect, so the counts below are not claims about all 8,192 physical slots in a full term.

## Eleven members fell off a cliff

Across the 92 post-exit memberships, I found 592,669 canonical block opportunities and 110,364 misses, an 18.62% miss rate. The distribution was lopsided:

- 71 memberships missed less than 10% after exit.
- 10 landed between 10% and 90%.
- 11 missed at least 90%, including three that missed every recorded aggregate for a full term.

Those 11 near-dark memberships missed 74,243 of 75,282 opportunities, or 98.62%. They were only 12.7% of the post-exit opportunity rows but produced 67.3% of all post-exit misses. For the 46 validators that exited during a term, the pooled miss rate before exit was just 0.66%. Several of the ugly cases were signing normally, crossed their exit epoch, managed roughly one more epoch of signatures, and then almost stopped.

<img src="/img/exited-sync-committee-duties.png" alt="Dark chart showing 92 exited sync-committee member-periods: 71 missed less than 10 percent after exit, 10 missed between 10 and 90 percent, and 11 missed at least 90 percent. Shared-scale bars compare a 0.66 percent pre-exit miss rate, 0.53 percent for the current exited member, 18.62 percent across all post-exit memberships, and 98.62 percent for the 11 near-dark memberships." loading="eager" />

The reward path agrees. I capped both tables at slot 15,071,615, the slower participation head at 18:43:23 UTC on August 25, then ran the same member-period bounds against raw `canonical_beacon_sync_committee_reward`. All 592,669 rows matched the refined participation rows, and every positive or negative reward sign matched the participation flag. Post-exit penalties totaled 2.689247292 ETH; the 11 near-dark memberships absorbed 1.809359837 ETH of that total.

## The current exited member kept signing

The live period gives a useful counterexample. Validator [1,832,296](https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/states/finalized/validators/1832296) exited at epoch 470876, partway through committee period 1839. Through slot 15,071,615, it missed 17 of 2,931 canonical aggregates before exit and 19 of 3,568 after exit. Its miss rate actually edged down from 0.58% to 0.53%.

So exit itself does not make a sync member fail. Most of this cohort kept working, including the one still serving today. The eleven cliffs could come from the Prysm REST bug, an operator removing an exited key, another client path, or plain downtime. Xatu does not expose the evidence needed to choose among those mechanisms, and I am not going to invent a client label from a signature pattern.

"Exited" answers whether a validator remains in the active set. It does not answer whether a committee chosen earlier still contains that pubkey. Duty code and operator shutdown logic both need the committee clock, not just the status string. That is the whole bug.
