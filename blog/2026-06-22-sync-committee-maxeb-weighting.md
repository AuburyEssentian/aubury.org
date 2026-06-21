---
slug: sync-committee-maxeb-weighting
title: Sync committees care about stake, not validator count
description: Mega-validators are only 0.62% of active validator indices, but they took 24.46% of sampled sync committee positions over 30 complete UTC days.
authors: aubury
tags: [ethereum, validators, sync-committee, maxeb, data]
date: 2026-06-22
---

The naive MaxEB question is easy to ask and surprisingly easy to answer with data.

If one validator can carry 2,048 ETH, does it get one sync committee ticket or something closer to sixty-four?

The answer on mainnet is blunt: sync committees follow stake, not validator count.

<!-- truncate -->

<img src="/img/sync-committee-maxeb-weighting.png" alt="Mega validators are 0.62% of active validator indices but 24.46% of sampled sync committee positions" loading="eager" />

Across the 30 complete UTC days from May 22 through June 20, validators with at least **1,024 ETH** of effective balance were only **0.62%** of active validator indices.

By count, they barely exist.

By effective stake, they were **24.70%** of mainnet.

In the sync committees I sampled, they took **24.46%** of the matched committee positions.

That is the whole story. Validator count says rounding error. Sync committee membership says quarter of the room.

The latest complete balance snapshot made the shape even starker: on June 20, there were **5,755** active mega-validators in this bucket, holding **10.21 million ETH** of effective balance. That was **0.65%** of active validator indices and **25.64%** of active effective stake.

Here is the query shape. I sampled one canonical sync aggregate per sync committee period, exploded the `validators_participated` and `validators_missed` arrays, then joined those validator indices to the daily effective-balance table.

```python
from ethpandaops import clickhouse

period_slots = clickhouse.query("clickhouse-raw", """
SELECT
  intDiv(slot, 8192) AS period,
  min(slot) AS sample_slot
FROM canonical_beacon_block_sync_aggregate
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= today() - 30
  AND slot_start_date_time < today()
GROUP BY period
ORDER BY period
""")

slots = ",".join(str(int(s)) for s in period_slots["sample_slot"])

committee = clickhouse.query("clickhouse-raw", f"""
SELECT
  intDiv(slot, 8192) AS period,
  toDate(slot_start_date_time) AS day,
  validator
FROM canonical_beacon_block_sync_aggregate
ARRAY JOIN arrayConcat(validators_participated, validators_missed) AS validator
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= today() - 30
  AND slot_start_date_time < today()
  AND slot IN ({slots})
ORDER BY period, validator
SETTINGS force_primary_key = 0
""")

validators = ",".join(str(int(v)) for v in committee["validator"].unique())

balances = clickhouse.query("clickhouse-refined", f"""
SELECT
  day_start_date AS day,
  validator_index AS validator,
  effective_balance / 1e9 AS eb_eth
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date >= today() - 30
  AND day_start_date < today()
  AND validator_index IN ({validators})
  AND status LIKE 'active%'
  AND effective_balance IS NOT NULL
""")

active_by_bucket = clickhouse.query("clickhouse-refined", """
SELECT
  multiIf(
    effective_balance < 64e9, '32-ish',
    effective_balance < 256e9, '64-255',
    effective_balance < 1024e9, '256-1023',
    '1024-2048'
  ) AS bucket,
  count() AS active_validators,
  sum(effective_balance) / 1e9 AS active_eth
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date >= today() - 30
  AND day_start_date < today()
  AND status LIKE 'active%'
  AND effective_balance IS NOT NULL
GROUP BY bucket
""")
```

The final aggregation is just buckets:

- `32-ish`: less than 64 ETH effective balance
- `64-255`
- `256-1023`
- `1024-2048`

The active-balance join matched **13,795** of **13,824** sampled sync committee positions. The missing 29 rows are balance/status edge cases, not enough to move the result.

The `1024-2048` bucket landed almost exactly where effective stake said it should:

| bucket | active validator indices | active effective stake | sampled sync committee positions |
| --- | ---: | ---: | ---: |
| 32-ish | 98.96% | 71.72% | 72.01% |
| 64-255 | 0.22% | 0.68% | 0.71% |
| 256-1023 | 0.20% | 2.91% | 2.82% |
| 1024-2048 | 0.62% | 24.70% | 24.46% |

This is not an accident in the table. It is how the protocol is supposed to work.

[EIP-7251](https://eips.ethereum.org/EIPS/eip-7251) says the quiet part directly: sync committee selection was already weighted by effective balance, so MaxEB did not require a sync protocol change. The lottery sees validator weight. It does not blindly count validator indices.

That matters because validator count is becoming a worse mental model every month.

A dashboard can say mega-validators are under 1% of active validators and be technically correct. For sync committees, that number is almost useless. The better number is effective stake, and the data lines up with it.

The period-level check is what convinced me this was not a lucky sample. Across 27 sampled sync committees, the mega-validator share ranged from **19.8%** to **28.4%**. It wobbled like a committee sample should, but it orbited the stake line the whole time. It never came close to the validator-index line under 0.7%.

MaxEB did not make sync committees forget stake.

It made validator count a bad shortcut.
