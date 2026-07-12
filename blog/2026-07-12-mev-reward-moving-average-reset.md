---
slug: mev-reward-moving-average-reset
title: 'The "6-hour" MEV reward average forgot five hours'
description: "Xatu's hourly proposer-reward table usually computes its six-hour moving average from the current hour alone. One early 12.5 ETH block pushed the stored value 17x above the real six-hour mean."
authors: aubury
tags: [ethereum, mev, data, xatu]
date: 2026-07-12T13:00:00+10:00
---

A six-hour moving average that only sees one hour is not smoothing much. At 23:00 UTC on July 10, Xatu's `fct_proposer_reward_hourly` stored **0.303736 ETH** in its `moving_avg_reward_eth` field. The actual six-hour mean was **0.017821 ETH**.

The 17x gap came from one **12.506337 ETH** relay-delivered block, included eleven seconds after the hour began. Because it landed first, the stored calculation kept re-counting it through almost every cumulative average in that hour. The previous five hours never entered the window.

<!-- truncate -->

<img src="/img/mev-reward-moving-average-reset.png" alt="Chart comparing Xatu's stored six-hour MEV proposer reward average with the actual six-hour mean on July 10, 2026. The stored value spikes to 0.304 ETH at 23:00 while the actual mean stays at 0.0178 ETH." loading="eager" />

This table covers positive-value, canonical blocks delivered through MEV relays. It does not include locally built blocks, and it is not the consensus-layer block reward. The ordinary hourly fields are straightforward aggregates over `mainnet.fct_block_mev`: count the blocks, convert the relay value from wei to ETH, then take the average and percentiles.

The moving average takes a stranger route. The [transformation source](https://github.com/ethpandaops/xatu-cbt/blob/3b07a105d1b400fe2e4722f4a7f2ddadeabb8e49/models/transformations/fct_proposer_reward_hourly.sql) first limits `slots_in_hours` to the hours inside the current transformation task. Only then does it ask ClickHouse for a six-hour window:

```sql
slots_in_hours AS (
  SELECT
    slot,
    slot_start_date_time,
    toUnixTimestamp(slot_start_date_time) AS slot_timestamp,
    toFloat64(value) / 1e18 AS reward_eth
  FROM mainnet.fct_block_mev FINAL
  WHERE slot_start_date_time >= min_hour
    AND slot_start_date_time <  max_hour + INTERVAL 1 HOUR
    AND status = 'canonical'
    AND value IS NOT NULL
    AND value > 0
),
slots_with_ma AS (
  SELECT
    *,
    avg(reward_eth) OVER (
      ORDER BY slot_timestamp
      RANGE BETWEEN 21600 PRECEDING AND CURRENT ROW
    ) AS ma_reward_eth
  FROM slots_in_hours
)
SELECT
  toStartOfHour(slot_start_date_time) AS hour,
  avg(ma_reward_eth) AS moving_avg_reward_eth
FROM slots_with_ma
GROUP BY hour
```

A window function cannot reach rows that its input query never loaded. On the usual one-hour forward-fill task, `RANGE BETWEEN 21600 PRECEDING` sounds six hours back but stops at the start of the current hour. The result is the average of a within-hour cumulative average. An early large block gets enormous leverage; a late one barely moves the field.

I reproduced both paths from the same block rows. `reset_each_hour` deliberately partitions the input at the hour boundary. `full_history_6h` leaves the preceding hours available to the window:

```sql
WITH slots AS (
  SELECT
    slot_start_date_time,
    toStartOfHour(slot_start_date_time) AS hour,
    toUnixTimestamp(slot_start_date_time) AS ts,
    toFloat64(value) / 1e18 AS reward_eth
  FROM mainnet.fct_block_mev FINAL
  WHERE slot_start_date_time >= toDateTime('2026-06-26 18:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-12 00:00:00')
    AND status = 'canonical'
    AND value IS NOT NULL
    AND value > 0
), windowed AS (
  SELECT
    *,
    avg(reward_eth) OVER (
      PARTITION BY hour ORDER BY ts
      RANGE BETWEEN 21600 PRECEDING AND CURRENT ROW
    ) AS reset_each_hour,
    avg(reward_eth) OVER (
      ORDER BY ts
      RANGE BETWEEN 21600 PRECEDING AND CURRENT ROW
    ) AS full_history_6h
  FROM slots
), recomputed AS (
  SELECT
    hour,
    round(avg(reset_each_hour), 6) AS reset_value,
    round(avg(full_history_6h), 6) AS actual_6h_value
  FROM windowed
  GROUP BY hour
)
SELECT
  r.hour,
  t.moving_avg_reward_eth AS stored_value,
  r.reset_value,
  r.actual_6h_value,
  round(stored_value / actual_6h_value, 3) AS ratio
FROM recomputed r
GLOBAL INNER JOIN (
  SELECT hour_start_date_time, moving_avg_reward_eth
  FROM mainnet.fct_proposer_reward_hourly FINAL
  WHERE hour_start_date_time >= toDateTime('2026-06-27 00:00:00')
    AND hour_start_date_time <  toDateTime('2026-07-12 00:00:00')
) t ON r.hour = t.hour_start_date_time
ORDER BY r.hour;
```

Across **360 complete hours** from June 27 through July 11, the stored value matched the within-hour reset exactly in **358**. The two exceptions were July 3 hours, consistent with a wider backfill task supplying more history. Against the real six-hour series, the stored value ran above 2x in **31 hours**, above 5x twice, and below half in **34 hours**. This is not a simple upward bias. It depends on where the expensive blocks sit inside each processing batch.

July 10 at 23:00 is the cleanest failure. The hour contained 268 relay-delivered canonical blocks with an ordinary average value of **0.058321 ETH**. The first block paid 12.506337 ETH, so averaging the hour's cumulative averages produced 0.303736 ETH, more than five times the ordinary hourly average and 17.044x the six-hour mean.

I checked that block and the six-hour denominator against the raw relay surface rather than trusting the refined table twice. I fetched `mev_relay_proposer_payload_delivered` and `canonical_beacon_block` separately, deduped relay observations by block hash, and joined them locally. The seven-hour slice had **1,931** matched relay-delivered canonical payloads. It reproduced the same 12.506337 ETH maximum, 0.058321 ETH hourly average, and **0.017821 ETH** six-hour value.

This is a window-frame bug, not an MEV market event. The table's count, total, ordinary average, min, max, and percentile fields still answer their hourly questions. I would not use `moving_avg_reward_eth` as a six-hour trend line until the transformation loads the preceding six hours before applying the window. The daily sibling uses the same bounded-input pattern for its advertised seven-day average, so that field needs the same treatment.
