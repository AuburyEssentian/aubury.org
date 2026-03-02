---
title: "The First MaxEB Slashing: What Actually Happened to a 2,020 ETH Validator"
slug: maxeb-slashing
authors: [aubury]
tags: [ethereum, validators, maxeb, slashing, pectra]
---

Pectra introduced `MAX_EFFECTIVE_BALANCE` — letting validators hold up to 2,048 ETH instead of a hard cap of 32. On May 8, 2025, the day after Pectra went live, Abyss Finance consolidated 60+ validators into a single mega-validator with nearly 2,020 ETH of stake. Four months later, on September 10, it was slashed.

This is the first time a MaxEB compounding validator has been slashed on Ethereum mainnet. The data tells an interesting story — not because the penalty was catastrophic, but because of exactly how *gentle* it was.

<!-- truncate -->

## The incident

On September 10, 2025, at 13:24–13:30 UTC, 40 validators were slashed in a six-minute window. The slashing evidence — packed into 76 attester slashing operations — points to double-voting: validators signing two conflicting attestations for the same slot. The tightly-clustered timing suggests a key management failure or infrastructure incident rather than a protocol bug.

Among the 40 newly slashed validators was validator 1073521, owned by Abyss Finance. Effective balance: **2,020 ETH**.

```sql
-- Validators newly slashed on Sep 10, 2025
SELECT sep10.validator_index, sep10.effective_balance/1e9 as eff_eth, sep10.status
FROM mainnet.fct_validator_balance_daily sep10
LEFT JOIN mainnet.fct_validator_balance_daily sep9
  ON sep10.validator_index = sep9.validator_index AND sep9.day_start_date = '2025-09-09'
WHERE sep10.day_start_date = '2025-09-10'
  AND sep10.slashed = true AND (sep9.slashed = false OR sep9.slashed IS NULL)
ORDER BY effective_balance DESC LIMIT 5
```

```
1073521    2020    active_slashed
9431       32      active_slashed
27255      32      active_slashed
...
```

## How the penalty changed

Here's the part most people don't know: Electra (Pectra) changed `MIN_SLASHING_PENALTY_QUOTIENT` from **32 to 4096**. That's a 128× reduction in the initial slash penalty. The empirical data confirms it exactly.

```sql
-- Pre-Pectra (March 2025): validator 1718351, 32 ETH effective balance
-- day_start_date = '2025-03-04', newly slashed
-- day0_loss_eth = 1.018 ETH  → ratio: 32 / 1.018 ≈ 31.4  (quotient ≈ 32)

-- Post-Pectra (Sep 2025): validator 59421, 32 ETH effective balance
-- day_start_date = '2025-09-10', newly slashed
-- day0_loss_eth = 0.0074 ETH → ratio: 32 / 0.0074 ≈ 4,324 (quotient ≈ 4096)
```

The same pattern holds for the mega-validator:

| Validator | Effective Balance | Day-0 Penalty | % of Balance | Era |
|---|---|---|---|---|
| 1718351 | 32 ETH | ~1.02 ETH | 3.125% | Pre-Pectra |
| 59421 | 32 ETH | ~0.007 ETH | 0.024% | Post-Pectra |
| 1073521 | 2,020 ETH | ~0.43 ETH | 0.021% | Post-Pectra (MaxEB) |

The fraction is consistent across both post-Pectra validators regardless of size. The new quotient applies universally in Electra.

![Chart showing validator 1073521's balance lifecycle from consolidation through slashing, and bar chart comparing pre/post-Pectra initial slash penalties on a log scale](/img/maxeb-slashing-2025.png)

## The lifecycle

Validator 1073521 had a short, eventful life:

- **May 7, 2025** — Pectra activates. The validator holds 32 ETH.
- **May 8** — Abyss Finance merges 60+ validators in. Balance jumps from 32 ETH to ~1,920 ETH overnight.
- **May 9–11** — Additional consolidations bring it to 2,000 ETH effective balance. It has 0x02 (compounding) withdrawal credentials, so rewards compound instead of being auto-withdrawn.
- **Sep 6** — Another top-up, balance reaches 2,020 ETH.
- **Sep 10, 13:26 UTC** — Slashed. The initial penalty: **0.43 ETH** (1/4096 of 2,020 ETH).
- **Sep 10–Oct 22** — Sits in `active_slashed`, draining at ~0.096 ETH/day (the inactivity leak applied to slashed validators).
- **Oct 22** — Forced exit, status becomes `exited_slashed`.
- **Oct 28** — Withdrawal of **2,014.96 ETH**.

```sql
SELECT day_start_date, end_balance/1e9 as eth, effective_balance/1e9 as eff, status
FROM mainnet.fct_validator_balance_daily
WHERE validator_index = 1073521
  AND day_start_date IN ('2025-05-08','2025-09-10','2025-10-22','2025-10-28')
ORDER BY day_start_date
```

```
2025-05-08    1920.04   1920   active_ongoing
2025-09-10    2020.06   2020   active_slashed
2025-10-22    2015.21   2015   exited_slashed
2025-10-28    2014.96   2015   withdrawal_done
```

**Total loss: 5.53 ETH.** That's 0.27% of the peak 2,020 ETH effective balance.

Under the old rules (pre-Pectra quotient of 32), the initial penalty alone would have been ~63 ETH, and total losses somewhere around 67–70 ETH — more than **12× worse**.

## What this means for the protocol

The change wasn't accidental. EIP-7251 deliberately made slashing less punishing per-ETH to accommodate mega-validators, where a 1/32 penalty on 2,048 ETH (64 ETH immediately) would be catastrophic and disproportionate to the actual harm of a single double-vote.

The tradeoff is subtle: the *absolute* ETH penalty for a slashed mega-validator (0.43 ETH initial) is now actually *less* than the pre-Pectra penalty for 32 ETH validators (1 ETH initial), even though the mega-validator holds 63× more stake. The penalty structure scales sub-linearly with stake.

Whether this is the right calibration is an open research question. The correlation penalty (applied ~18 epochs after slashing) still scales with how much total stake was slashed in the surrounding window — so a mass slashing event would still hurt proportionally. With only 3,268 ETH slashed across 40 validators versus ~31 million ETH of total active stake, the correlation multiplier on Sep 10 was tiny (≈0.032%), adding less than 1 ETH to each validator's final bill.

The Sep 10 incident cost Abyss Finance 5.53 ETH out of 2,020. A rounding error in the history of a major staking operation. The bigger cost — reputational and operational — almost certainly dominated.
