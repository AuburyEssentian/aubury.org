---
slug: eip-8333-slot-zero-target-misses
title: "Slot zero owns 96% of target-vote misses"
description: "Fourteen days of validator-duty data show that Ethereum's first slot carries 3.1% of attested duties but 96.1% of incorrect FFG target votes. Almost every miss points to the prior epoch boundary."
authors: aubury
tags: [ethereum, consensus, attestations, finality, eip-8333]
date: 2026-08-16
---

The first committee of an Ethereum epoch has an awkward job. Its FFG target is the block being proposed in the same slot, so some validators vote before that block reaches them and some vote after.

That little race owns almost the entire target-miss surface. Across the first 14 complete UTC days of August, slot zero carried **3.12% of attested validator duties and 96.13% of incorrect target votes**.

<!-- truncate -->

<img src="/img/eip-8333-slot-zero-target-misses.png" alt="Slot zero carried 3.1 percent of attested duties but 96.1 percent of target misses from August 1 through 14, 2026. Its daily target-miss rate ranged from 1.1 to 3.7 percent, while slots 1 through 31 combined missed at 0.0026 percent." loading="eager" />

## The first slot is the weird one

I started with `mainnet.fct_attestation_vote_correctness_by_validator`, which is one row per validator duty and slot. The window contains **2,814,361,941 attested duties** and **1,858,957 target misses**. Slot zero contributed 1,786,952 of those misses despite carrying only 87,911,276 attested duties.

This is the exact aggregate query. I used `FINAL`, kept the two denominators separate, and froze complete UTC days rather than letting the head of the chain leak into the result.

```sql
SELECT
  countIf(attested = 1) AS attested_duties,
  countIf(attested = 1 AND target_correct = 0)
    AS all_target_misses,
  countIf(attested = 1 AND target_correct = 0 AND slot % 32 = 0)
    AS slot_zero_target_misses,
  countIf(attested = 1 AND target_correct = 0 AND slot % 32 != 0)
    AS other_slot_target_misses,
  countIf(attested = 1 AND slot % 32 = 0)
    AS slot_zero_attested,
  countIf(attested = 1 AND slot % 32 != 0)
    AS other_slot_attested
FROM mainnet.fct_attestation_vote_correctness_by_validator FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-01 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-15 00:00:00');
```

Slot zero's target-miss rate was **2.0327%**. Slots 1 through 31 combined missed at **0.002641%**, making the first-slot rate about **770 times higher**. The slot-zero rate moved between 1.11% and 3.71% by day, but the shape never went away.

These are validator-duty counts, not stake-weighted FFG weight. MaxEB means one validator index no longer represents one fixed chunk of effective balance, so I am not turning this into an ETH reward estimate or claiming that 96.1% of missed target *weight* sits here.

## The losing root is not random

A boolean correctness field tells us that a vote missed. It does not tell us what the validator saw, so I checked the raw canonical attestations and exact block roots.

For every slot-zero attestation, I expanded the validator array and counted unique validator indices by `(slot, target_root)`. The expansion is deliberate here: `arrayJoin` changes the row grain before aggregation, and `uniqExact` puts it back at validator-duty-and-root grain.

```sql
SELECT
  slot AS duty_slot,
  target_root,
  uniqExact(validator_index) AS unique_validators
FROM (
  SELECT
    slot,
    target_root,
    arrayJoin(validators) AS validator_index
  FROM default.canonical_beacon_elaborated_attestation FINAL
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-08-01 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-15 00:00:00')
    AND block_slot_start_date_time < toDateTime('2026-08-15 01:00:00')
    AND slot % 32 = 0
)
GROUP BY duty_slot, target_root
ORDER BY duty_slot, unique_validators DESC;
```

I fetched canonical blocks separately and resolved two roots locally for each epoch: the canonical block at the first slot, if one existed, and the latest canonical block at or before the previous slot. That avoids a large distributed join and gives the two sides of the race honest names.

The raw roots reproduced the refined table exactly. The 86,124,324 correct slot-zero votes split into 83,440,142 votes for the first-slot block plus 2,684,182 votes for the boundary root when the epoch-start slot had no canonical block. The 1,786,952 misses split into:

- **1,756,837 votes for the prior boundary root**
- **22,318 other-root votes when the epoch-start slot had no canonical block**
- **7,797 other-root votes when the first-slot block existed**

No validator duty appeared under more than one target root. In other words, **98.31% of slot-zero target misses named exactly the root that was canonical immediately before the epoch began**. This is not a noisy correctness model finding. It is the epoch-boundary race printed in block roots.

## What EIP-8333 moves

Today, the checkpoint for epoch `N` resolves to the block at the first slot of epoch `N`, falling back to an earlier block if that slot is empty. [EIP-8333](https://eips.ethereum.org/EIPS/eip-8333) moves the anchor back one slot: the checkpoint becomes the latest block at or before the end of epoch `N - 1`.

That root is known before the new epoch starts. The first committee no longer has to race the first proposer, and finalizing epoch `N` would describe a chain through the whole previous epoch rather than only through the first block of the current one. The proposal is still Draft and needs a consensus fork; it is not scheduled for mainnet.

There were **97 epoch starts with no canonical block across 3,150 epochs** in this window. EIP-8333 is a no-op for those epochs because today's fallback already picks the prior boundary root. The behavior changes in the other 3,053 epochs, where a first-slot block existed and could split the committee's target.

One caveat matters. Reclassifying today's votes under the proposed rule is not an activation simulation: current clients are still instructed to vote for the first-slot root. The raw data measures the present race and shows what the losing side saw. It does not forecast how every client will behave after a fork.

Still, the mechanism is unusually clean. A slot that carries about one duty in 32 produces 96% of the target misses, and 98% of those misses point one block boundary backward.

That is exactly the off-by-one EIP-8333 is trying to remove.
