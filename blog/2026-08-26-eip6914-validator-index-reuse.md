---
slug: eip6914-validator-index-reuse
title: "The removed validator-reuse rule had 1.1 million holes ready"
description: "Consensus-specs removed stagnant EIP-6914. At finalized epoch 471,117, its old rule already classified 1,125,125 zero-balance validator indices as safe to reuse, starting with index 41."
authors: [aubury]
tags: [ethereum, validators, consensus, eip-6914, data]
date: 2026-08-26
---

Yesterday, consensus-specs deleted its implementation of [EIP-6914](https://eips.ethereum.org/EIPS/eip-6914). The proposal is Stagnant and nobody expects it in an upcoming fork, so removing dead code is sensible. What surprised me was how much work that dead code was already ready to do.

<!-- truncate -->

At finalized epoch **471,117**, the old rule marked **1,125,125 validator indices** as reusable. That is 47.94% of Ethereum's entire 2,347,182-entry validator registry and 78.18% of its zero-balance `withdrawal_done` rows. If the deleted code had activated against that state, the first new pubkey would have received **validator index 41**.

<img src="/img/eip6914-validator-index-reuse.png" alt="Dark chart showing Ethereum's validator registry split into 1,125,125 indices reusable under the old EIP-6914 rule, 314,099 withdrawn indices still waiting through the safety period, and 907,958 other positions. Stacked bars by validator-index range show reusable holes concentrated in older indices, with a callout that index 41 would be selected first." loading="eager" />

The rule was blunt. A validator became reusable once its balance was zero and more than 65,536 epochs had passed since `withdrawable_epoch`. That wait is about **291.27 days** on mainnet. The deleted `get_index_for_new_validator` helper then scanned the registry from index zero and returned the first match, which is why index 41 matters rather than merely being a fun old number.

I froze the latest finalized Xatu state and applied that predicate literally. The extra timestamp filter is deliberate: `canonical_beacon_validators` is an epoch-snapshot table, and filtering only on `epoch` throws away its useful partition clock.

```sql
SELECT
  count() AS registry_rows,
  uniqExact(index) AS unique_indices,
  max(index) AS max_index,
  countIf(status = 'withdrawal_done') AS withdrawal_done,
  countIf(
    balance = 0
    AND withdrawable_epoch IS NOT NULL
    AND toUInt128(epoch) > toUInt128(withdrawable_epoch) + 65536
  ) AS reusable_indices,
  minIf(
    index,
    balance = 0
    AND withdrawable_epoch IS NOT NULL
    AND toUInt128(epoch) > toUInt128(withdrawable_epoch) + 65536
  ) AS first_reusable_index,
  maxIf(
    withdrawable_epoch,
    balance = 0
    AND withdrawable_epoch IS NOT NULL
    AND toUInt128(epoch) > toUInt128(withdrawable_epoch) + 65536
  ) AS latest_safe_withdrawable_epoch
FROM default.canonical_beacon_validators FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch = 471117
  AND epoch_start_date_time = toDateTime('2026-08-26 08:29:11');
```

The snapshot was clean: `count()`, `uniqExact(index)`, and `max(index) + 1` all returned **2,347,182**. Every zero-balance row was already `withdrawal_done`. Of those 1,439,224 dead positions, 1,125,125 passed the old safety clock and 314,099 were still waiting. The newest eligible rows had `withdrawable_epoch = 405580`; because the comparison was strict, a row at 405581 had to wait one more epoch.

The holes are not spread evenly. There were **75,342 reusable positions in the first 100,000 indices**, and the old loop would have reached the first one after checking only 42 entries. At the other end, the 2.1m-2.2m range had five eligible positions and the registry above 2.2m had none. This was a hole-filling scheme, not a compaction scheme: the list would stay the same length while old indices acquired new pubkeys.

I also checked how that stock compares with current append traffic. Across 15 complete day-to-day steps from August 10 through August 25, the refined daily state grew by **13,261 indices**, or a mean of **884 per day**. At that short recent rate, the already-safe pool equals about **3.48 years** of new indices, before counting any of the waiting cohort that becomes safe later.

```sql
SELECT
  day_start_date,
  max(validator_index) + 1 AS registry_length,
  count() AS snapshot_rows,
  countIf(status = 'withdrawal_done') AS withdrawal_done_count
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date >= toDate('2026-08-10')
  AND day_start_date <= toDate('2026-08-25')
GROUP BY day_start_date
ORDER BY day_start_date;
```

That is not a forecast. Validator intake changes, exits keep moving, and the old rule would add another 32,414 safe holes within 30 days, 71,508 over the following 60 days, and 210,177 more within a year if the state otherwise stood still. The point is simpler: the reusable cohort was not theoretical or tiny.

The cross-checks were reassuringly boring. The refined `dim_validator_status FINAL` path lagged two fresh `withdrawal_done` transitions, but it reproduced the exact **1,125,125** reusable count and the same index bounds. A public finalized Beacon API independently reported epoch 471,117 and returned indices 41, 42, and 2,109,884 as zero-balance `withdrawal_done` validators with the same lifecycle epochs.

[EIP-6914 remains Stagnant](https://eips.ethereum.org/EIPS/eip-6914), and [consensus-specs PR #5568](https://github.com/ethereum/consensus-specs/pull/5568) removed the implementation on August 25 because it is not expected in an upcoming upgrade. Nothing changed on mainnet, and no validator index is being recycled today. The removal just makes the trade-off hard to miss: Ethereum keeps appending validator records while nearly half of the current registry already passes the abandoned reuse rule.

The first hole is 41.
