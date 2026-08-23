---
slug: eip8148-compounding-stake-denominator
title: "0x02 is 2% of active validators and 33% of stake"
description: "EIP-8148 calls compounding-validator adoption low; current mainnet agrees by key count and strongly disagrees by effective stake."
authors: aubury
tags: [ethereum, validators, staking, eip-8148, data]
date: 2026-08-23
---

[EIP-8148](https://eips.ethereum.org/EIPS/eip-8148) says the rate of validators moving to `0x02` compounding credentials has been very low. That is true if a validator means a key: on the complete UTC day of August 21, `0x02` was **17,780 of 901,667 active indices, or 1.97%**. Those keys carried **14.05 million of Ethereum's 42.33 million active effective ETH, or 33.19%**.

<!-- truncate -->

<img src="/img/eip8148-compounding-stake-denominator.png" alt="Two paired bar comparisons showing that 0x02 compounding credentials are 1.97% of active validator indices but 33.19% of active effective stake, while validators currently able to choose a 128 ETH threshold are 41.88% of active 0x02 indices but only 2.26% of active 0x02 stake." loading="eager" />

That denominator flip matters because this proposal moved twice in the past few days. An [August 20 edit](https://github.com/ethereum/EIPs/commit/ed0a51053e1783bfd8a39af3f4efaac3d8f1dbd3) added deposit-time thresholds and lowered the minimum to 32 ETH. Then [consensus-specs PR #5557](https://github.com/ethereum/consensus-specs/pull/5557) merged on August 22, setting the default threshold when a validator switches to `0x02` and capping effective balance at the chosen threshold. EIP-8148 is still Draft and only Proposed for Inclusion in [Hegotá](https://eips.ethereum.org/EIPS/eip-8081); none of this is live.

## The denominator flips

I resolved the latest credential for every validator first. The withdrawal-credential table keeps historical credential rows, so filtering every row beginning with `0x02` would retain validators after another credential became authoritative. `argMax` makes the cohort current.

```sql
SELECT index
FROM (
    SELECT
        index,
        argMax(
            withdrawal_credentials,
            tuple(epoch, updated_date_time)
        ) AS credential
    FROM default.canonical_beacon_validators_withdrawal_credentials FINAL
    WHERE meta_network_name = 'mainnet'
    GROUP BY index
)
WHERE startsWith(credential, '0x02')
ORDER BY index;
```

That returned **24,971 indices**. I passed them to `mainnet.fct_validator_balance_daily FINAL` in literal batches of at most 3,000, then kept the `active_*` rows from the complete August 21 snapshot. This is the actual bounded query shape; a large distributed cross-table subquery was slower and less reliable than fetching the small credential cohort first.

```sql
-- Repeated with each literal batch of at most 3,000 indices.
SELECT
    validator_index,
    end_balance,
    effective_balance,
    status
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date = toDate('2026-08-21')
  AND validator_index IN (<0x02_indices>);
```

For the network denominator, I used the same table and day. It contained **901,667 active indices** and **42,333,847 active effective ETH**. The `0x02` cohort had only 17,780 keys but 14,050,074 effective ETH. The exact daily cohort packet hashes to `d6be137b...bdddb7`; rerunning the current-state path at epoch 470,352 produced the same shape with 17,811 active keys and 14,059,229 effective ETH.

The concentration is not subtle. At epoch 470,352, **6,801 active `0x02` validators had at least 1,024 ETH of effective balance**. They were 38.18% of the active `0x02` keys and carried 12.14 million ETH, or 86.35% of the cohort's effective stake. MaxEB packed a lot of old validator weight behind a small number of indices, so "low adoption" changes meaning depending on which unit gets counted.

## The 128 ETH example is the small end

EIP-8148 uses a 128 ETH validator as its worked example: let rewards compound to 128 ETH, then sweep future excess automatically. The request rule has an important edge, though. A validator may only set a threshold at or above its current balance; lowering the balance first still requires the partial-withdrawal path the proposal is trying to make less annoying for routine rewards.

I froze epoch **470,352**, at 2026-08-22 22:53:11 UTC, and queried the 24,971-index cohort from `mainnet.fct_validator_balance FINAL` in the same 3,000-index batches:

```sql
SELECT
    validator_index,
    balance,
    effective_balance,
    status
FROM mainnet.fct_validator_balance FINAL
WHERE epoch = 470352
  AND validator_index IN (<0x02_indices>);
```

Of the 17,811 active `0x02` validators, **7,459 had a current balance at or below 128 ETH**. That is a healthy-looking 41.88% of the keys, but they carried only **317,324 effective ETH, or 2.26% of active `0x02` stake**. The median active balance was 291.25 ETH. The other 10,352 active validators were already above 128 ETH and held 13.74 million effective ETH.

This is not a hidden 128 ETH haircut. A larger validator can choose a larger threshold, and existing `0x02` validators receive the 2,048 ETH default at activation. The newly merged effective-balance cap also creates no immediate loss for the validators currently eligible at 128 ETH: all of them already had effective balance at or below that threshold. The point is narrower and uglier. The proposal's clean 128 ETH example describes 41.88% of today's compounding keys but only 2.26% of their stake.

So yes, `0x02` adoption is low by key count. By the unit Ethereum uses for rewards, consensus weight, churn and finality, it is already one-third of active stake. Both numbers are true. Calling the cohort simply "small" is not.
