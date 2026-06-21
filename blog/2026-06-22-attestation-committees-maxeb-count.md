---
slug: attestation-committees-maxeb-count
title: Attestation committees still count validators, not stake
description: Large-balance validators are 25.64% of active effective stake, but only 0.646% of ordinary attestation committee positions. Proposer and sync selection tell the opposite story.
authors: aubury
tags: [ethereum, validators, maxeb, attestations, panda]
date: 2026-06-22
---

Large-balance validators have a split personality now.

The same `>=1024 ETH` cohort is **25.64%** of active effective stake, but only **0.646%** of ordinary attestation committee positions.

<!-- truncate -->

<img src="/img/attestation-committees-maxeb-count.png" alt="Large-balance validators are 0.65% of active indices and ordinary attestation positions, but roughly 25% of proposer duties, sync slots, and effective stake" loading="eager" />

I got here by following the obvious follow-up to the sync committee post. Sync committees were clean: MaxEB-sized validators showed up close to their stake share, not their raw index count. Fine. That matches the spec.

Then I asked the dumber question: does the same thing happen in ordinary beacon committees, the ones validators use for attestations every epoch?

No. It disappears.

On June 20 UTC, the active set had:

- **877,423** plain 32 ETH validators, **70.50%** of active effective stake
- **5,755** validators at `>=1024 ETH`, **25.64%** of active effective stake
- only **0.65%** of active validator indices in that `>=1024 ETH` bucket

Ordinary attestation committees followed the index count almost exactly. The large-balance cohort got **1,291,332** of **199,908,043** matched committee assignments: **0.646%**.

Here is the query for the weird part:

```sql
WITH positions AS (
  SELECT arrayJoin(validators) AS validator_index
  FROM mainnet.int_beacon_committee_head FINAL
  WHERE slot_start_date_time >= toDateTime('2026-06-20 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-21 00:00:00')
), bal AS (
  SELECT
    validator_index,
    effective_balance,
    multiIf(
      effective_balance >= 1024000000000, '1024-2048 ETH',
      effective_balance >=  256000000000, '256-1023 ETH',
      effective_balance >    32000000000, '33-255 ETH',
      '32 ETH'
    ) AS bucket
  FROM mainnet.fct_validator_balance_daily FINAL
  WHERE day_start_date = toDate('2026-06-20')
    AND startsWith(status, 'active')
)
SELECT
  bucket,
  count() AS committee_positions,
  uniqExact(positions.validator_index) AS unique_validators,
  round(100 * count() / sum(count()) OVER (), 4) AS position_share_pct
FROM positions
INNER JOIN bal USING validator_index
GROUP BY bucket
ORDER BY min(effective_balance);
```

Result:

| Bucket | Committee positions | Position share |
|---|---:|---:|
| 32 ETH | 197,420,064 | 98.7554% |
| 33-255 ETH | 766,621 | 0.3835% |
| 256-1023 ETH | 430,026 | 0.2151% |
| 1024-2048 ETH | 1,291,332 | **0.6460%** |

This is not a small-sample wobble. Over the seven complete days from June 14 to June 20, the `>=1024 ETH` bucket sat between **0.634%** and **0.646%** of ordinary committee positions while its effective-stake share sat between **25.27%** and **25.64%**.

The contrast is the point.

Block proposer duties over May 22-June 20 landed at **24.82%** for the same bucket. Sync committee slots landed at **24.46%**. Both are close to stake share. Ordinary attestation committee positions are not even trying to be close.

That sounds strange until you look at the spec paths. `get_beacon_committee` passes `get_active_validator_indices(...)` into `compute_committee(...)`, which shuffles indices. There is no effective-balance weighting in that committee assignment path.

Proposer selection and sync committee selection take a different path. After Electra, both use an effective-balance acceptance test against `MAX_EFFECTIVE_BALANCE_ELECTRA`. Balance is literally part of the random selection test there.

So Ethereum now has two surfaces that look similar from a distance but are not doing the same thing:

- ordinary attestation committee positions: index shuffle
- block proposer and sync committee selection: effective-balance weighted

Important caveat: I am counting **committee positions**, not final attestation weight or reward accounting. A 2,048 ETH validator is not magically reduced to a 32 ETH validator when rewards and consensus balances are computed. The odd part is the assignment surface itself: one validator index gets one ordinary attestation committee assignment per epoch, whether that index carries 32 ETH or 2,048 ETH.

That makes validator-count dashboards even more slippery after MaxEB. Sometimes count is the right denominator. Sometimes stake is. Sometimes the protocol quietly uses both, depending on which lottery you are looking at.

I don't love that. It is easy to say "validators" and accidentally mean three different things.

For June 20, at least, the distinction is no longer theoretical. A quarter of active stake was almost invisible in the ordinary committee position count.

Raw-table cross-check: `canonical_beacon_committee` and `mainnet.int_beacon_committee_head` matched exactly for June 20 at **460,800** committee rows and **199,918,709** validator-index assignments. The balance join matched **199,908,043** of those assignments; **10,666** unmatched positions were dropped, less than **0.006%** of the sample.
