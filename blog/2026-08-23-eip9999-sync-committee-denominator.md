---
slug: eip9999-sync-committee-denominator
title: "EIP-9999's 0.06% counts validator keys, not stake"
description: "Draft EIP-9999 calls the sync committee 0.06% of the validator set. The current 512 keys carry 0.77% of active effective stake, and the gap held across 30 committee periods."
authors: aubury
tags: [ethereum, sync-committee, validators, maxeb, eip-9999, data]
date: 2026-08-23
---

[Draft EIP-9999](https://github.com/ethereum/EIPs/pull/12228) landed yesterday with a clean argument for deleting the sync committee: 512 validators, one seat per 1,761 validators, only 0.06% of the active set. At the start of the current committee period, `901,612 / 512` was **1,760.96**. The arithmetic is almost comically exact.

The word "validator" is doing too much work.

<!-- truncate -->

<img src="/img/eip9999-sync-committee-denominator.png" alt="Across 30 recent mainnet sync committees, 512 selected keys were about 0.057% of the active validator-index count but carried 0.57% to 0.78% of active effective stake" loading="eager" />

At slot **15,048,704**, the first canonical block in sync committee period 1,837, the committee had 512 positions and 512 distinct validator indices. Those keys carried **326,694 ETH** of effective balance against **42,335,470 ETH** in the active set. That is **0.7717%** of active effective stake, compared with **0.0568%** when the same 512 keys are divided by the active validator-index count.

So the stake ratio is **13.59 times** the key-count ratio. One selected index was already `exited_unslashed` at the period boundary; the other 511 were `active_ongoing`. That edge is useful on its own: a committee period is a preselected set of positions, not a live query for 512 currently active keys.

Here is the exact query path. I pulled membership from the first canonical sync aggregate in the period, fetched those 512 indices from the canonical validator state at the same epoch, and compared their effective balances with the complete active-state aggregate. The `UInt128` cast keeps the stake sum boring.

```python
from ethpandaops import clickhouse

committee = clickhouse.query("clickhouse-raw", """
SELECT
  slot,
  epoch,
  epoch_start_date_time,
  validators_participated,
  validators_missed
FROM default.canonical_beacon_block_sync_aggregate FINAL
WHERE meta_network_name = 'mainnet'
  AND slot = 15048704
LIMIT 1
""")

positions = (
  committee.iloc[0]["validators_participated"]
  + committee.iloc[0]["validators_missed"]
)
ids = ",".join(str(v) for v in sorted(set(positions)))

selected = clickhouse.query("clickhouse-raw", f"""
SELECT
  index AS validator_index,
  argMax(effective_balance, updated_date_time) AS effective_balance,
  argMax(status, updated_date_time) AS status
FROM default.canonical_beacon_validators FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch = 470272
  AND epoch_start_date_time = toDateTime('2026-08-22 14:21:11')
  AND index IN ({ids})
GROUP BY validator_index
""")

active = clickhouse.query("clickhouse-raw", """
SELECT
  countIf(status LIKE 'active%') AS active_keys,
  toString(sum(toUInt128(
    if(status LIKE 'active%', effective_balance, 0)
  ))) AS active_effective_gwei
FROM default.canonical_beacon_validators FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch = 470272
  AND epoch_start_date_time = toDateTime('2026-08-22 14:21:11')
""")
```

I did not want to hang the post on one lucky committee. Across 30 periods from July 21 through August 22, every sampled committee again had **512 positions and 512 distinct keys**. The key-count ratio stayed between **0.0568% and 0.0578%**, while the full effective balance carried by those keys ranged from **0.5709% to 0.7789%** of the daily active stake. The median was **0.6915%**, or 12.07 times the median key-count ratio.

The membership sample was safe because the sorted 512-key set stayed constant in every canonical aggregate within each period. This is the check I used before taking one block per period:

```sql
SELECT
  sync_committee_period,
  min(slot) AS sample_slot,
  min(length(validators_participated) + length(validators_missed))
    AS min_positions,
  max(length(validators_participated) + length(validators_missed))
    AS max_positions,
  uniqExact(cityHash64(arraySort(arrayConcat(
    validators_participated,
    validators_missed
  )))) AS membership_set_hashes
FROM default.canonical_beacon_block_sync_aggregate FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-21 00:00:00')
  AND slot_start_date_time < toDateTime('2026-08-23 00:00:00')
GROUP BY sync_committee_period
ORDER BY sync_committee_period
```

The current high-balance cohort makes the mechanism hard to miss. Only **6,801** active validators had at least 1,024 ETH of effective balance, **0.7543%** of active indices. They held **28.6742%** of active effective stake and occupied **166 of 512 positions**, or **32.4219%**, in period 1,837. Across the 30 periods, their position share ranged from 22.66% to 32.62%, with a 28.42% median.

That is what the [Electra selection function](https://github.com/ethereum/consensus-specs/blob/34d86966f4c7e2aeacc66249bc814ef6ad6efdbd/specs/electra/beacon-chain.md#get_next_sync_committee_indices) says should happen. Candidate acceptance is weighted by `effective_balance / MAX_EFFECTIVE_BALANCE_ELECTRA`, and the function explicitly allows duplicate indices. I found no duplicate positions in these 30 committees, but the protocol does not promise 512 unique keys. [EIP-7251](https://eips.ethereum.org/EIPS/eip-7251) is blunt about the reason: sync selection already follows effective balance, so MaxEB did not need a new sync protocol.

There is an equally important boundary here. The selected keys carrying 0.77% of stake does **not** give the sync committee 0.77% of slashable backing. Sync committee messages are not slashable today, which is one of EIP-9999's main complaints. Nor does a 2,048 ETH validator get 64 times the vote after selection; each selected position contributes one bit, and the per-position reward is flat.

EIP-9999 may still be right that the sync committee should die. Its ZK replacement, issuance claim, and deployment plan need separate scrutiny. But "0.06% of the validator set" is a key-count statistic in a system that stopped treating keys as equal-sized validators. It makes the sample sound an order of magnitude thinner than the effective balances of the selected keys actually are.
