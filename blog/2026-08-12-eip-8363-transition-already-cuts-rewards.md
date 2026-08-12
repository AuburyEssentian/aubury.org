---
slug: eip-8363-transition-already-cuts-rewards
title: "EIP-8363's gentle transition is already a 16% reward cut"
description: "At Ethereum's August 12 active effective balance, EIP-8363 would burn 58.0% of each doubled launch-era duty reward, leaving 84.0% of the current curve."
authors: aubury
tags: [ethereum, staking, validators, issuance, eip-8363, data]
date: 2026-08-12
---

[EIP-8363](https://eips.ethereum.org/EIPS/eip-8363) arrived in the EIPs repository yesterday with a cushion: double the base reward factor at activation, then decay it back to today's value over 18 months. That sounds like a gentle start. At Ethereum's current active effective balance, it is already a **16.0% cut** to the net consensus reward curve.

The reason is simple. The proposal doubles gross duty rewards, but it also burns **58.0% of each doubled reward**. A fully performing duty nets 84.0% of what the current curve pays.

<!-- truncate -->

<figure>
  <a href="/img/eip-8363-transition-already-cuts-rewards.png">
    <img src="/img/eip-8363-transition-already-cuts-rewards.png" alt="EIP-8363 launch-era net reward multiplier calculated from Ethereum's active effective balance from May 7 through August 12 2026. The multiplier fell from 97.2% to 84.0% of the current reward curve as active balance increased." loading="eager" />
  </a>
  <figcaption>The yellow line applies EIP-8363's proposed launch formula to each day's active effective balance. It is policy arithmetic, not an activation forecast; the EIP is still a draft and has no fork date.</figcaption>
</figure>

## The cushion moved under the draft

EIP-8363 charges every assigned validator duty a burn fraction of `b = (D / 60.25 million ETH)^1.5`, where `D` is total active effective balance. At activation, the proposal temporarily raises `BASE_REWARD_FACTOR` from 64 to 128. Gross rewards, penalties and the burn basis all double together. For a fully performed duty, the launch-era net reward relative to today's curve is therefore `2 × (1 - b)`.

That multiplier equals 100% only while active effective balance is **37.955 million ETH**. Ethereum is already well past it.

I pulled one semantic row per validator from the latest daily `FINAL` snapshot. `effective_balance` is stored in gwei, so the query divides its sum by $10^9$ before applying the EIP's 60.25 million ETH constant.

```sql
WITH current_day AS (
  SELECT max(day_start_date) AS day
  FROM mainnet.fct_validator_balance_daily FINAL
  WHERE day_start_date >= toDate('2026-08-01')
), totals AS (
  SELECT
    day_start_date,
    countIf(status LIKE 'active_%') AS active_validators,
    toFloat64(sumIf(toUInt128(effective_balance), status LIKE 'active_%')) / 1e9
      AS active_effective_eth
  FROM mainnet.fct_validator_balance_daily FINAL
  WHERE day_start_date = (SELECT day FROM current_day)
  GROUP BY day_start_date
)
SELECT
  day_start_date,
  active_validators,
  active_effective_eth,
  pow(active_effective_eth / 60250000, 1.5) * 100 AS burn_pct,
  200 * (1 - pow(active_effective_eth / 60250000, 1.5)) AS launch_net_pct
FROM totals;
```

At **09:33 UTC on August 12**, the current snapshot held **897,064 active validators** and **41,909,311 ETH** of active effective balance. The formula gives a **58.0137% burn** and an **83.9727% launch multiplier**. Rounded honestly: 58.0% burned, 84.0% left, a 16.0% cut from the current curve.

I cross-checked the daily model against the raw canonical validator state rather than trusting one aggregate. Epoch 467,977 contained 2,334,055 unique validator indices. Filtering that exact epoch to active statuses produced the same 897,064 validators and the same 41,909,311 ETH.

```sql
WITH latest_epoch AS (
  SELECT max(epoch) AS epoch
  FROM default.canonical_beacon_validators FINAL
  WHERE meta_network_name = 'mainnet'
    AND epoch_start_date_time >= toDateTime('2026-08-12 00:00:00')
    AND epoch_start_date_time <  toDateTime('2026-08-13 00:00:00')
)
SELECT
  epoch,
  countIf(status LIKE 'active_%') AS active_validators,
  toFloat64(sumIf(toUInt128(effective_balance), status LIKE 'active_%')) / 1e9
    AS active_effective_eth
FROM default.canonical_beacon_validators FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch = (SELECT epoch FROM latest_epoch)
  AND epoch_start_date_time >= toDateTime('2026-08-12 00:00:00')
  AND epoch_start_date_time <  toDateTime('2026-08-13 00:00:00')
GROUP BY epoch;
```

The timing is awkward. The EIP was created on July 14, when active effective balance was **40,690,723 ETH**. Even then, its launch multiplier was only **89.0%** of the current curve. Since that date, active effective balance grew by **1,218,588 ETH**, while the active validator count grew by 15,858.

MaxEB matters here. Active effective balance held by validators above 32 ETH grew by **743,551 ETH, or 61.0% of the total increase**. A validator-count chart would badly understate how quickly the proposal's burn fraction moved because one consolidated validator index can now carry far more than 32 ETH of effective balance.

## This is policy arithmetic, not a yield forecast

The 84.0% figure is not a prediction of an individual validator's APY. It holds stake and network conditions fixed and compares the proposal's own launch-era duty arithmetic with the current reward curve. Actual validator returns also depend on participation, proposals, sync-committee assignments, penalties, execution rewards and whatever active balance exists when a fork eventually activates.

There is no activation fork yet. Stake can move in either direction, and the EIP can change. But the draft's temporary `128` base reward factor is often described as if it preserves today's rewards at launch. That was only true below 37.955 million active ETH. On August 12, the chain was 3.95 million ETH beyond that break-even point.

The transition still cushions the permanent curve. It just is not neutral anymore.
