---
slug: compounding-withdrawal-full-exits-correction
title: "The compounding withdrawal spike was 43 full exits"
description: "A correction: the large Feb 21 withdrawals totalled 58,177.93 ETH across 43 validators. 99.11% was original deposit principal, not excess rewards."
authors: [aubury]
tags: [ethereum, validators, pectra, withdrawals, correction]
date: 2026-07-16
---

I got the February compounding-validator withdrawal post wrong. The 12:00 UTC batch was real: 42 withdrawals carrying 56,827.19 ETH. But those were not the first giant automatic payouts above the 2,048 ETH cap. They were full validator exits, and **99.11%** of the day's corrected 58,177.93 ETH was deposited principal.

<!-- truncate -->

The old headline said 52 withdrawals and 76,322 ETH on February 21. I cannot reproduce either number from the canonical table now. This is the corrected count, with the semantic withdrawal key kept beside the raw row count:

```sql
SELECT
  countIf(withdrawal_amount >= 1000000000000) AS large_rows,
  uniqExactIf(tuple(
    block_root,
    withdrawal_index,
    withdrawal_validator_index
  ), withdrawal_amount >= 1000000000000) AS unique_large_withdrawals,
  sumIf(
    withdrawal_amount,
    withdrawal_amount >= 1000000000000
  ) / 1e9 AS large_eth
FROM default.canonical_beacon_block_withdrawal FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-02-21 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-02-22 00:00:00');
```

That returns **43 rows, 43 unique withdrawals and 58,177.925631086 ETH**. Running the old query shape without `FINAL` now returns the same 43 rows, so there is no current duplicate tail to blame. I also fetched the decoded canonical `SignedBeaconBlock` for all 15 affected block roots. Every `(slot, withdrawal_index, validator_index, amount)` tuple matched: 43 in the table, 43 in the raw blocks, nothing left over on either side. Whether the old total came from transient table parts or my own bookkeeping, it is not a chain fact and I am retracting it.

The hour that started this rabbit hole does survive. From 12:08:23 through 12:55:35 UTC, **42 validators withdrew 56,827.190668681 ETH** across 14 canonical blocks. That was 97.68% of the day's corrected large-withdrawal volume. The clustering was real; my explanation for it was not.

<a href="/img/compounding-withdrawal-full-exits-correction.png" target="_blank" rel="noopener noreferrer">
  <img src="/img/compounding-withdrawal-full-exits-correction.png" alt="The Feb 21 large validator withdrawals totalled 58,177.93 ETH. Original deposits supplied 57,660 ETH, or 99.11%, while only 517.93 ETH was earned. All 43 validators had full-withdrawal state and zero post-withdrawal balances." loading="eager" />
</a>

<small><a href="/img/compounding-withdrawal-full-exits-correction.png" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a></small>

My original query only knew that `withdrawal_amount >= 1,000 ETH`. That is not a full-versus-partial classifier. I saw `0x02` credentials, values around 1,800 ETH and a 2,048 ETH cap, then filled in a reward-compounding story without checking the validator state.

For the correction, I fetched the 43 validator indices from the withdrawal query, then resolved one exact pre-withdrawal state. Epoch 429300 began before the first large withdrawal, so it gives one clean state row for every validator:

```python
large_withdrawals = clickhouse.query("clickhouse-raw", """
SELECT withdrawal_validator_index AS validator_index
FROM default.canonical_beacon_block_withdrawal FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-02-21 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-02-22 00:00:00')
  AND withdrawal_amount >= 1000000000000
""")
indices = ",".join(map(str, large_withdrawals["validator_index"]))

states = clickhouse.query("clickhouse-raw", f"""
SELECT
  index AS validator_index,
  argMax(balance, updated_date_time) AS balance_gwei,
  argMax(effective_balance, updated_date_time) AS effective_balance_gwei,
  argMax(status, updated_date_time) AS validator_status,
  argMax(withdrawable_epoch, updated_date_time) AS withdrawable_epoch
FROM default.canonical_beacon_validators FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch_start_date_time >= toDateTime('2026-02-21 11:55:00')
  AND epoch_start_date_time <  toDateTime('2026-02-21 12:05:00')
  AND epoch = 429300
  AND index IN ({indices})
GROUP BY index
""")
```

All 43 validators had `status = 'withdrawal_possible'`, all 43 had reached their `withdrawable_epoch`, and each pre-state balance matched its later withdrawal amount exactly. The next state reduced every balance to zero and marked every validator `withdrawal_done`. Their median effective balance was 1,323 ETH; the maximum was 1,817 ETH.

That last number kills the partial-withdrawal theory. Electra's [`is_partially_withdrawable_validator`](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/electra/beacon-chain.md#modified-is_partially_withdrawable_validator) requires a validator's effective balance to equal its maximum and its actual balance to sit above that maximum. For a compounding `0x02` validator, [`MAX_EFFECTIVE_BALANCE_ELECTRA` is 2,048 ETH](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/electra/beacon-chain.md#gwei-values). None of these validators even reached 2,048 ETH effective balance. They did satisfy the separate [`is_fully_withdrawable_validator`](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/electra/beacon-chain.md#modified-is_fully_withdrawable_validator) test: execution withdrawal credentials, a reached withdrawable epoch and a positive balance.

The deposit rows make the mistake look even sillier. I mapped the 43 validator indices to pubkeys, then queried their EIP-6110 intake separately:

```sql
SELECT
  pubkey,
  count() AS deposit_rows,
  sum(amount) / 1e9 AS deposited_eth,
  min(slot_start_date_time) AS first_deposit_time,
  any(substring(withdrawal_credentials, 1, 4)) AS credential_prefix
FROM default.canonical_beacon_block_execution_request_deposit FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2025-05-07 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-02-22 00:00:00')
  AND pubkey IN ({pubkeys_from_the_43_validator_indices})
GROUP BY pubkey;
```

Every validator had one deposit request with `0x02` credentials. They were funded from October 6 through October 13, 2025, in five bluntly obvious sizes: 15 deposits of 1,056 ETH, 15 of 1,312 ETH, one of 1,340 ETH, two of 1,400 ETH and ten of 1,800 ETH. The original principal adds to **57,660 ETH**. The withdrawals add to 58,177.925631086 ETH, leaving **517.925631086 ETH of earnings**, or 0.89% of the total.

So the 1,818 ETH example was not a validator growing from 32 ETH to the cap in four weeks. It was a **1,800 ETH deposit** plus 18.029596 ETH earned over roughly four and a half months. Across the cohort, the deposit-to-withdrawal interval was 130.9 to 137.9 days and the earned amount was 8.56 to 18.03 ETH per validator. I also had the fork date wrong: [Pectra activated on mainnet on May 7, 2025](https://blog.ethereum.org/2025/04/23/pectra-mainnet), not January 25, 2026.

The exit path is unusually tidy. All 43 validators appear in canonical voluntary-exit inclusions, and none appears in the EIP-7002 withdrawal-request table. **42 exit messages landed between 17:13:59 and 17:37:59 UTC on February 13**; the remaining one landed on February 19. The sweep then paid their full remaining balances on February 21. This was a coordinated cohort of large `0x02` validators leaving, not a set of validators independently bumping into the compounding cap.

I am retracting the old 1.16% credential-adoption estimate too. That query counted rows from a credential-history surface over a day and called them validators. The current safe reduction, latest credential per validator index, gives 22,923 `0x02` credentials across 2,308,990 historical indices, or 0.993%. It does not reconstruct the February 24 active-validator share, so I am not going to invent a replacement for that date.

The corrected story is less exotic. Forty-three validators were deposited with unusually large `0x02` balances, earned 517.93 ETH in total, exited and had their entire balances swept. A compounding credential changes the balance rules. It does not turn every large withdrawal into an over-cap reward payout.
