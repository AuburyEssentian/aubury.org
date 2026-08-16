---
slug: gloas-equivocation-double-credit
title: No mainnet slashing proof matches Gloas's double-credit bug
description: Consensus-specs fixed a Gloas builder-payment double count under target equivocation. Across 552 canonical mainnet attester-slashing proofs, none matched the exact same-head trigger.
authors: aubury
tags: [ethereum, consensus, gloas, eip-7732, slashing, panda]
date: 2026-08-17
---

The Gloas spec had a nasty edge: one validator could count twice toward a builder payment by sending two slashable attestations. [The fix merged on August 16](https://github.com/ethereum/consensus-specs/pull/5543). Mainnet's **552 included attester-slashing proofs contain zero examples of the exact trigger**.

<!-- truncate -->

[EIP-7732](https://eips.ethereum.org/EIPS/eip-7732) is still in Review and the Gloas fork schedule is still TBD. None of this code is active on mainnet, so no historical builder payment was at risk. I am using old attestation evidence as a backcast against the proposed state transition, not claiming the bug happened in production.

<img src="/img/gloas-equivocation-double-credit.png" alt="Funnel of 552 canonical mainnet attester-slashing proofs: 529 were double-vote proofs, 32 had the same slot and source with conflicting target roots, and zero also reused the same beacon head required by the Gloas builder-payment double-credit regression." loading="eager" />

## The bug was two flags and one balance

Gloas tracks a pending builder payment for each slot. Same-slot attestations add their validators' effective balance to `payment.weight`, and the builder gets paid at the epoch boundary once that weight reaches 60% of one slot's share of active stake.

The old `process_attestation` path credited a validator whenever an attestation set any new participation flag. That is the crack. A wrong-target attestation could set `TIMELY_SOURCE`, then a right-target attestation from the same validator could set `TIMELY_TARGET`; each pass added the validator's effective balance. The second signature was slashable, but nothing removed the extra payment weight.

The merged patch is blunt. It records whether the validator had no participation flags before processing the attestation and credits payment weight only on that first flag-setting pass. Honest single attestations behave as before.

## The funnel ends at zero

I had already [reduced the two evidence arrays to their per-proof intersections](/blog/attester-slashing-overlap/). This pass asks a narrower question: how many proofs reproduce the regression test's data shape?

The raw table covers every included canonical attester-slashing proof from December 3, 2020 through March 31, 2026. It has 552 stored rows and 552 unique proofs. As a separate coverage check, validator state at epoch 468,971 contained 573 slashed validators; the evidence tables accounted for exactly the same set as 554 attester-evidence validators plus 19 proposer-evidence validators, with no overlap or missing index.

Here is the query that produced the four chart rows:

```sql
WITH proofs AS (
  SELECT
    block_root,
    attestation_1_signature AS sig_1,
    attestation_2_signature AS sig_2,
    attestation_1_data_slot AS slot_1,
    attestation_2_data_slot AS slot_2,
    attestation_1_data_index AS data_index_1,
    attestation_2_data_index AS data_index_2,
    attestation_1_data_beacon_block_root AS head_1,
    attestation_2_data_beacon_block_root AS head_2,
    attestation_1_data_source_epoch AS source_epoch_1,
    attestation_2_data_source_epoch AS source_epoch_2,
    attestation_1_data_source_root AS source_root_1,
    attestation_2_data_source_root AS source_root_2,
    attestation_1_data_target_epoch AS target_epoch_1,
    attestation_2_data_target_epoch AS target_epoch_2,
    attestation_1_data_target_root AS target_root_1,
    attestation_2_data_target_root AS target_root_2
  FROM default.canonical_beacon_block_attester_slashing FINAL
  WHERE meta_network_name = 'mainnet'
  GROUP BY ALL
)
SELECT
  count() AS all_proofs,
  countIf(
    target_epoch_1 = target_epoch_2
    AND tuple(
      slot_1, data_index_1, head_1,
      source_epoch_1, source_root_1,
      target_epoch_1, target_root_1
    ) != tuple(
      slot_2, data_index_2, head_2,
      source_epoch_2, source_root_2,
      target_epoch_2, target_root_2
    )
  ) AS double_vote_proofs,
  countIf(
    slot_1 = slot_2
    AND data_index_1 = data_index_2
    AND source_epoch_1 = source_epoch_2
    AND source_root_1 = source_root_2
    AND target_epoch_1 = target_epoch_2
    AND target_root_1 != target_root_2
  ) AS same_slot_source_conflicting_target,
  countIf(
    slot_1 = slot_2
    AND data_index_1 = data_index_2
    AND head_1 = head_2
    AND source_epoch_1 = source_epoch_2
    AND source_root_1 = source_root_2
    AND target_epoch_1 = target_epoch_2
    AND target_root_1 != target_root_2
  ) AS exact_regression_shape
FROM proofs;
```

The first cut found **529 double-vote proofs**. Narrowing to the same attestation slot, data index and source checkpoint with conflicting target roots left **32 proofs**, each implicating one overlapping validator. Adding the regression test's shared beacon head removed all 32.

That last field is not cosmetic. Gloas's `is_attestation_same_slot` check requires the attested beacon head to equal the block actually proposed at the attestation slot. If both signatures change the target but also change the head, they cannot both pass that check against one canonical chain.

I fetched the canonical block root for every candidate slot through `canonical_beacon_block` as a separate raw path. In 30 of the 32 proofs, exactly one evidence head matched the canonical block at that slot; in the other two, neither did. Both heads matched in **zero** proofs, which independently reproduces the final funnel row.

## Zero is a boundary, not a safety proof

This is a complete audit of included slashing proofs, not a complete archive of every equivocation ever broadcast. An equivocation may never reach a canonical slashing operation, and a future adversary can deliberately construct the same-head, conflicting-target sequence used by the regression test.

The patch is still right. Consensus accounting should not pay twice because a second slashable signature found a different participation flag. But this particular test case is a constructed edge, not a replay of anything in canonical mainnet slashing evidence so far.
