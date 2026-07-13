---
slug: attester-slashing-overlap
title: "245,290 attesting-index positions collapsed to 555 overlaps"
description: "Across every canonical mainnet attester-slashing proof, two evidence arrays carried 245,290 validator-index positions. The protocol intersected them into 555 overlap positions covering 554 validators."
authors: [aubury]
tags: [ethereum, staking, validators, slashing, data]
date: 2026-07-13T22:08:02+10:00
---

`canonical_beacon_block_attester_slashing` stores two attesting-index arrays for every proof. Summing those arrays across mainnet gives **245,290 validator-index positions**. The protocol intersected them into **555 overlap positions**, covering 554 unique validators. The arrays are evidence, not a validator-slashing counter.

<!-- truncate -->

An `AttesterSlashing` carries two conflicting `IndexedAttestation`s. Each index array lists the validators covered by that aggregate signature. The proof can show a double vote or a surround vote, but in either case [the state transition takes the set intersection](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/phase0/beacon-chain.md#L1961-L1974) and only tries to slash eligible validators found in both arrays.

That detail is easy to miss because the Xatu table exposes both complete arrays. I started by keeping the arrays intact and counting their intersection per proof:

```sql
SELECT
  count() AS rows,
  uniqExact(tuple(
    block_root,
    attestation_1_signature,
    attestation_2_signature
  )) AS unique_proofs,
  uniqExact(block_root) AS blocks,
  sum(
    length(attestation_1_attesting_indices)
    + length(attestation_2_attesting_indices)
  ) AS raw_index_positions,
  sum(length(arrayIntersect(
    attestation_1_attesting_indices,
    attestation_2_attesting_indices
  ))) AS overlap_positions,
  round(raw_index_positions / overlap_positions, 6) AS ratio
FROM default.canonical_beacon_block_attester_slashing FINAL
WHERE meta_network_name = 'mainnet';
```

The table held **552 rows, 552 unique proofs and 456 containing blocks** from December 3, 2020 through March 31, 2026. Those proofs carried 126,273 positions in the first arrays and 119,017 in the second, or 245,290 combined. Their per-proof intersections contained 555 positions. The raw arrays were **441.964x** larger than the part the protocol actually intersected.

<a href="/img/attester-slashing-overlap.png?v=20260713-2215" target="_blank" rel="noopener noreferrer">
  <img src="/img/attester-slashing-overlap.png?v=20260713-2215" alt="Linear-scale comparison of 245,290 validator-index positions carried in two attester-slashing evidence arrays against 555 positions surviving the per-proof set intersection, a 442-times difference." loading="eager" />
</a>

<small><a href="/img/attester-slashing-overlap.png?v=20260713-2215" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a></small>

Most proofs were much less dramatic than the total, but the shape barely changed. **549 of 552 proofs had one overlap position; the other three had two.** The median proof carried 272 positions across its two arrays and intersected on one. The largest carried 32,947 positions and intersected on two, while a February 2026 proof carried 30,123 positions and intersected on one.

That is not a malformed proof. The aggregate signatures on either side can cover huge, mostly different validator sets. The candidates for slashing are the validators who signed both conflicting attestations; the state transition then filters that overlap for validators still eligible to be slashed. In this history, 529 proofs had different attestation data at the same target epoch, the double-vote shape defined in the spec; the remaining 23 had the source/target nesting of a surround vote.

I expanded only the intersection in a separate query. Doing `arrayJoin` in the headline aggregation would multiply the three two-validator proofs and quietly corrupt the proof and array totals.

```sql
SELECT
  count() AS overlap_positions,
  uniqExact(validator_index) AS unique_overlap_validators
FROM (
  SELECT arrayJoin(arrayIntersect(
    attestation_1_attesting_indices,
    attestation_2_attesting_indices
  )) AS validator_index
  FROM default.canonical_beacon_block_attester_slashing FINAL
  WHERE meta_network_name = 'mainnet'
);
```

That returned **555 positions and 554 unique validators**. One validator appeared in two proof intersections five minutes apart near genesis; the later proof also intersected on a second validator. So 555 is still not a distinct-validator count.

The current validator state gave me a cleaner cross-check than another sum over the same table. At epoch 461,247, mainnet had **573 validators with `slashed = true`**. I fetched those indices, the 554 historical attester-overlap indices, and the 19 proposer indices from `canonical_beacon_block_proposer_slashing`, then compared the sets locally:

```sql
-- Attester-slashing evidence set
SELECT DISTINCT arrayJoin(arrayIntersect(
  attestation_1_attesting_indices,
  attestation_2_attesting_indices
)) AS validator_index
FROM default.canonical_beacon_block_attester_slashing FINAL
WHERE meta_network_name = 'mainnet';

-- Proposer-slashing evidence set
SELECT DISTINCT signed_header_1_message_proposer_index AS validator_index
FROM default.canonical_beacon_block_proposer_slashing FINAL
WHERE meta_network_name = 'mainnet';

-- Current state set, resolved at one exact epoch snapshot
SELECT index AS validator_index
FROM default.canonical_beacon_validators FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch = 461247
  AND epoch_start_date_time = toDateTime('2026-07-13 11:41:11')
  AND slashed;
```

The attester and proposer sets had no overlap. Their union contained 573 validators and matched the current state's 573 slashed validators exactly, with nothing missing on either side. All 554 validators from the attester-proof intersections had `slashed = true` in that snapshot. The separate block-reward table could not help here: its coverage began on June 25, 2026, almost three months after the last attester-slashing inclusion in this dataset.

If the question is how much evidence an attester-slashing operation carries, the two arrays are useful. If the question is how many validators the proof implicates, intersect the arrays per proof, apply the state eligibility check, and then deduplicate. Summing both sides turns every index position in the evidence into a fake slashing count. The evidence is large; the protocol starts with the overlap.
