---
title: "The 76,322 ETH Withdrawal Spike: Compounding Validators Wake Up"
description: "A deep dive into the first wave of mass compounding validator withdrawals after the Pectra upgrade"
authors: [aubury]
tags: [ethereum, pectra, validators, withdrawals, research]
date: 2026-02-25
---

# The 76,322 ETH Withdrawal Spike: Compounding Validators Wake Up

Something unusual happened on February 21, 2026. While scanning Ethereum's withdrawal data, a pattern emerged that didn't fit the normal rhythm of the network. **52 validators withdrew over 1,000 ETH each in a single hour** — a volume we haven't seen since the Pectra upgrade activated on January 25.

<!-- truncate -->

## The Discovery

Most Ethereum withdrawals are predictable. Validators with 0x01 credentials receive their consensus rewards — typically 0.01-0.02 ETH every few days. It's a steady heartbeat, background noise in the machine.

But the Pectra upgrade introduced something new: **0x02 compounding withdrawal credentials**. These validators don't receive automatic payouts. Instead, rewards compound in-place until the balance exceeds the 2048 ETH maximum effective balance, at which point the excess is withdrawn.

This creates a different pattern. Rather than frequent small withdrawals, compounding validators accumulate rewards until they hit the threshold, then release a flood.

## The Data

Querying `canonical_beacon_block_withdrawal` from the Xatu dataset:

```sql
SELECT 
  toDate(slot_start_date_time) as day,
  countIf(withdrawal_amount >= 1e12) as large_withdrawals,
  sumIf(withdrawal_amount, withdrawal_amount >= 1e12) / 1e9 as large_eth
FROM canonical_beacon_block_withdrawal
WHERE slot_start_date_time >= now() - INTERVAL 14 DAY
GROUP BY day
ORDER BY day
```

The results show a clear escalation:

| Date | Large Withdrawals (≥1,000 ETH) | Total ETH |
|------|-------------------------------|-----------|
| Feb 10 | 0 | 0 |
| Feb 13 | 31 | 57,993 |
| Feb 14 | 22 | 44,165 |
| Feb 20 | 18 | 36,771 |
| **Feb 21** | **52** | **76,322** |
| Feb 22 | 0 | 0 |

February 21 stands out. The 52 large withdrawals that day represent **76,322 ETH** — more than double the daily average of the preceding week.

![Compounding Validator Withdrawals After Pectra](/img/compounding-withdrawals-pectra.png)

## The Hourly Breakdown

Zooming into February 21 by hour reveals the concentration:

```sql
SELECT 
  toHour(slot_start_date_time) as hour,
  countIf(withdrawal_amount >= 1e12) as large_withdrawals,
  sumIf(withdrawal_amount, withdrawal_amount >= 1e12) / 1e9 as large_eth
FROM canonical_beacon_block_withdrawal
WHERE slot_start_date_time >= '2026-02-21 00:00:00' 
  AND slot_start_date_time < '2026-02-22 00:00:00'
GROUP BY hour
ORDER BY hour
```

- **04:00-06:00 UTC**: 5 validators, 10,080 ETH
- **12:00 UTC**: **42 validators, 56,827 ETH** — the spike
- **14:00-19:00 UTC**: 4 validators, 8,018 ETH

The 12:00 UTC cluster is remarkable. 42 validators, all withdrawing 1,000+ ETH within the same hour. These aren't random — they're a coordinated cohort.

## Who Are These Validators?

Looking at the validator indices from the February 21 12:00 UTC batch:

```sql
SELECT 
  withdrawal_validator_index,
  withdrawal_amount / 1e9 as eth_amount,
  withdrawal_address
FROM canonical_beacon_block_withdrawal
WHERE slot_start_date_time >= '2026-02-21 12:00:00' 
  AND slot_start_date_time < '2026-02-21 13:00:00'
  AND withdrawal_amount >= 1e12
ORDER BY eth_amount DESC
LIMIT 5
```

| Validator Index | ETH Withdrawn | Withdrawal Address |
|----------------|---------------|-------------------|
| 2109254 | 1,818.03 | 0x096BC969... |
| 2109323 | 1,817.98 | 0xb1241d13... |
| 2110655 | 1,816.95 | 0x2d82F61B... |
| 2110999 | 1,816.74 | 0x16C33c16... |
| 2111060 | 1,816.56 | 0x4698a71c... |

All indices are in the 2.1M range — recently deposited validators. The withdrawal amounts (~1,816 ETH each) suggest these validators were deposited with 0x02 credentials from inception, accumulated rewards for roughly 4 weeks, and hit their first automatic withdrawal when exceeding the 2048 ETH cap.

## The Bigger Picture

As of February 24, only **1.16% of validators** have upgraded to 0x02 credentials:

```sql
SELECT 
  substring(withdrawal_credentials, 1, 4) as cred_type,
  count() as validator_count,
  round(100.0 * validator_count / sum(count()) OVER (), 2) as pct
FROM canonical_beacon_validators_withdrawal_credentials
WHERE epoch_start_date_time >= now() - INTERVAL 1 DAY
GROUP BY cred_type
```

| Credential Type | Count | Percentage |
|----------------|-------|------------|
| 0x01 | 4,076,196 | 70.1% |
| 0x00 | 1,671,434 | 28.74% |
| 0x02 | 67,539 | 1.16% |

The vast majority of validators still use 0x01 credentials with automatic reward distribution. But the 0x02 cohort is growing, and their withdrawal pattern is fundamentally different.

## Why This Matters

Compounding validators create **lumpier withdrawal flows**. Instead of a steady stream of small payouts, we get periodic bursts when multiple validators hit the 2048 ETH threshold simultaneously.

February 21 may be a preview. As more validators upgrade to 0x02 credentials — especially existing validators migrating from 0x01 — we could see larger, less predictable withdrawal events.

For staking operators, this changes liquidity planning. For the network, it means withdrawal volume will become more bursty. For analysts, it's a new pattern to track.

The 76,322 ETH withdrawn on February 21 didn't stress the network. But it was a signal. The compounding validators have arrived.

---

*Data from Xatu (Ethereum consensus layer telemetry) covering February 10-24, 2026. Queries executed against the `canonical_beacon_block_withdrawal` table.*
