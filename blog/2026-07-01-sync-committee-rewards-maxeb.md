---
slug: sync-committee-rewards-maxeb
title: Sync committee rewards do not square MaxEB
description: Large-balance validators are selected for sync committees by stake, but the per-member sync reward is flat. In the first reward-table window, 1024+ ETH validators took 26.36% of sync rewards, not the 91.56% a stake-squared mental model predicts.
authors: aubury
tags: [ethereum, maxeb, sync-committee, rewards, xatu]
date: 2026-07-01
---

I almost talked myself into a fake MaxEB panic: sync committee selection is stake-weighted, attestation rewards scale with effective balance, so maybe sync committee rewards accidentally scale like stake squared.

They don't. In the first usable `canonical_beacon_sync_committee_reward` window I checked, validators with **1024+ ETH** effective balance were **0.67%** of active validator indices, **26.45%** of active effective stake, **26.20%** of observed sync committee member-slots, and **26.36%** of sync committee rewards. The scary stake-squared model would put them at **91.56%**.

<!-- truncate -->

<img src="/img/sync-committee-rewards-maxeb.png" alt="Sync committee rewards for 1024+ ETH validators track committee positions, not stake squared" loading="eager" />

The reason is a small but important split in the spec. Electra changed sync committee selection so a validator's chance of being selected is proportional to effective balance. A 2,048 ETH validator has roughly 64 old-validator units behind one index, and sync committee selection sees that.

But once the validator is in the committee and participates in a slot, the sync reward is not calculated with that validator's own effective balance. The Altair sync aggregate code computes one global `participant_reward` and applies the same amount to each participating committee member. Selection is stake-weighted. Payment per selected member-slot is flat.

The data path was the new reward table, deduped by `(slot, validator_index)` because the raw table can carry repeated ingest rows:

```sql
SELECT
  validator_index,
  count() AS positions,
  countIf(reward > 0) AS positive_positions,
  countIf(reward < 0) AS negative_positions,
  sum(reward) AS reward_gwei,
  avgIf(reward, reward > 0) AS avg_positive_reward_gwei
FROM (
  SELECT
    slot,
    validator_index,
    argMax(reward, updated_date_time) AS reward
  FROM canonical_beacon_sync_committee_reward
  WHERE meta_network_name = 'mainnet'
  GROUP BY slot, validator_index
)
GROUP BY validator_index
```

That covered the reward table's available mainnet window, **2026-06-25 04:57:59** through **2026-06-28 22:08:11 UTC**: **25,052 slots** and **12,826,624** deduped member-slot rewards. I joined the selected validator indices to `mainnet.fct_validator_balance_daily FINAL` by UTC day, then bucketed by effective balance. For the active-set baseline, I used the June 28 daily balance snapshot.

| effective balance bucket | active index share | active stake share | observed sync positions | sync reward share | positive reward / member-slot |
| --- | ---: | ---: | ---: | ---: | ---: |
| 32-ish ETH | 98.73% | 69.78% | 70.05% | 70.00% | 24,395 gwei |
| 33-127 ETH | 0.27% | 0.36% | 0.23% | 0.23% | 24,404 gwei |
| 128-1023 ETH | 0.33% | 3.41% | 3.52% | 3.41% | 24,395 gwei |
| 1024+ ETH | 0.67% | 26.45% | 26.20% | 26.36% | 24,395 gwei |

That last column is the sanity check. A 32 ETH validator and a 2,048 ETH validator got the same positive reward for one participating sync member-slot in this window, about **24,395 gwei**. The big validator gets selected more often. It does not get paid more for the same selected slot.

Here is the spec shape that makes this happen. Electra's sync committee selection uses effective balance in the acceptance test:

```python
if effective_balance * MAX_RANDOM_VALUE >= MAX_EFFECTIVE_BALANCE_ELECTRA * random_value:
    sync_committee_indices.append(candidate_index)
```

The sync aggregate reward path is different. It computes a single participant reward from global active balance, then applies that same reward to every participating committee member:

```python
max_participant_rewards = Gwei(
    total_base_rewards * SYNC_REWARD_WEIGHT // WEIGHT_DENOMINATOR // SLOTS_PER_EPOCH
)
participant_reward = Gwei(max_participant_rewards // SYNC_COMMITTEE_SIZE)

for participant_index, participation_bit in zip(
    committee_indices,
    sync_aggregate.sync_committee_bits,
    strict=True,
):
    if participation_bit:
        increase_balance(state, participant_index, participant_reward)
```

That is why the scary bar in the chart is wrong. If sync committee selection and per-member payment both scaled by effective balance, the expected reward share would roughly follow `sum(effective_balance^2)`. On the June 28 active set, that puts the 1024+ ETH bucket at **91.56%**. The actual reward share was **26.36%**, basically the same as its committee-position share.

This does not make MaxEB invisible. The 1024+ ETH cohort is still only **5,969** active validator indices and still receives about a quarter of sync committee positions because those indices carry about a quarter of active effective stake. That part is real. The part that is not real is the extra squaring step.

Small caveat: this is not a long trend. The reward table currently covers a few days, not months, and I am treating it as a protocol-accounting check rather than an operator-performance study. For this question, that is enough. The per-member reward formula is flat in the spec, and the reward table shows the flatness directly.