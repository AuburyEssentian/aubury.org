---
slug: gas-limit-registration-fossils
title: "The 36M gas limit signals are fossils"
description: "MEV relay registration caches still contain old 30M and 36M gas limit values. The same validators are proposing roughly 60M gas blocks."
authors: [aubury]
tags: [ethereum, gas-limit, mev-boost, validators, data]
date: 2026-06-22
---

I had been reading the gas-limit signalling table too literally.

It shows a stubborn 30M/36M tail, even though Ethereum's block headers have been sitting around 60M gas for months. I used to describe that tail as validators still signalling old limits. That was too generous. A chunk of it looks like relay-registration fossils.

<!-- truncate -->

![Gas-limit registration fossils](/img/gas-limit-registration-fossils.png)

The table behind this is `mev_relay_validator_registration`. It is not a block-header vote. It is what relays have cached for validator registrations: fee recipient, timestamp, gas limit, relay name, validator index.

That distinction matters.

Using the latest cached registration per validator fetched between June 19 and June 22, I get this:

- **90.49%** of validators had a cached registration at exactly **60M** gas.
- **7.52%** were cached below **45M**.
- The **30-36M** bucket had **9,179** validators, and its median signed timestamp was **2020-12-01 12:00:23**. Beacon genesis time.
- The **36-45M** bucket had **56,424** validators. Its median signed timestamp was **2026-03-06**, or about **108 days** old at fetch time.

That timestamp is inside the signed registration. It is not when Panda fetched the row. So the genesis-time entries are not a fresh 2026 signal. They are old signatures still sitting in relay caches.

Here is the query I used for the chart. The important bit is the join to actual proposed blocks at the bottom. If a validator's relay registration says 30M or 36M but the validator later proposes a 60M block, the registration is not a live gas-limit preference.

```sql
WITH latest AS (
  SELECT
    validator_index,
    argMax(gas_limit, event_date_time) AS reg_gas_limit,
    argMax(timestamp, event_date_time) AS reg_ts,
    max(event_date_time) AS fetched_at,
    uniqExact(relay_name) AS relay_count
  FROM mev_relay_validator_registration
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-06-19 00:00:00')
    AND event_date_time <  toDateTime('2026-06-22 10:00:00')
  GROUP BY validator_index
), proposed AS (
  SELECT
    proposer_index AS validator_index,
    count() AS blocks,
    avg(execution_payload_gas_limit) AS avg_block_gas_limit,
    min(execution_payload_gas_limit) AS min_block_gas_limit,
    max(execution_payload_gas_limit) AS max_block_gas_limit
  FROM canonical_beacon_block
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-15 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-22 00:00:00')
    AND execution_payload_gas_limit > 0
  GROUP BY proposer_index
)
SELECT
  multiIf(
    reg_gas_limit < 30000000, '<30M',
    reg_gas_limit < 36000000, '30-36M',
    reg_gas_limit < 45000000, '36-45M',
    reg_gas_limit < 60000000, '45-60M',
    reg_gas_limit = 60000000, '60M exact',
    reg_gas_limit < 100000000, '60-100M',
    '100M+'
  ) AS reg_bucket,
  count() AS validators,
  round(100 * count() / sum(count()) OVER (), 3) AS pct_validators,
  round(quantileExact(0.5)(reg_gas_limit) / 1e6, 3) AS cached_p50_mgas,
  toString(quantileExact(0.5)(toDateTime(reg_ts))) AS p50_reg_time,
  round(quantileExact(0.5)((toUnixTimestamp(fetched_at) - reg_ts) / 86400), 1) AS p50_age_days,
  countIf(proposed.blocks > 0) AS validators_proposed,
  sum(proposed.blocks) AS proposed_blocks,
  round(avgIf(avg_block_gas_limit, proposed.blocks > 0) / 1e6, 3) AS actual_avg_mgas_for_proposers,
  round(minIf(min_block_gas_limit, proposed.blocks > 0) / 1e6, 3) AS actual_min_mgas_for_proposers,
  round(maxIf(max_block_gas_limit, proposed.blocks > 0) / 1e6, 3) AS actual_max_mgas_for_proposers
FROM latest
LEFT JOIN proposed USING (validator_index)
GROUP BY reg_bucket
ORDER BY min(reg_gas_limit)
```

The cross-check is the part that kills the naive interpretation.

Validators in the cached **30-36M** bucket proposed **433** blocks during June 15-21. Their actual block headers averaged **59.960M** gas.

Validators in the cached **36-45M** bucket proposed **2,973** blocks. Their actual block headers averaged **59.942M** gas.

So no, those cached registrations did not cap those blocks at 30M or 36M. They proposed normal 60M-ish blocks like everyone else.

I also checked the block-header surface directly:

```sql
SELECT
  toDate(slot_start_date_time) AS day,
  count() AS blocks,
  round(avg(execution_payload_gas_limit) / 1e6, 3) AS avg_mgas,
  round(min(execution_payload_gas_limit) / 1e6, 3) AS min_mgas,
  round(max(execution_payload_gas_limit) / 1e6, 3) AS max_mgas,
  countIf(execution_payload_gas_limit < 50000000) AS below50m_blocks
FROM canonical_beacon_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-15 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-06-22 00:00:00')
  AND execution_payload_gas_limit > 0
GROUP BY day
ORDER BY day
```

Every complete day from June 15 through June 21 averaged **59.992M to 59.995M** gas. There were **zero** blocks below 50M.

The old 36M tail is real as a relay-cache artifact. It is not real as a current block-production signal.

This does not change the 2025 gas-limit story. The actual block-header series still shows Ethereum moving from 30M to 36M, then 45M, then 60M. That part is clean.

It does change [the last paragraph I wrote back in February](/blog/2026/02/27/gas-limit-doubling). I treated `fct_execution_gas_limit_signalling_daily` as current validator preference. Looking at the raw relay-registration rows now, that is too strong. The safer read is:

> Relay registration caches still contain old gas-limit signatures. Some are ancient. Do not treat that table as a live vote without checking block headers.

That is a boring correction, but it matters. The block header is the vote. The relay cache is just a cache, and caches remember ghosts.
