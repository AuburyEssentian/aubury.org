---
slug: resource-gas-state-growth-correction
title: "A quarter of my 'state growth' gas grew no state"
description: "A correction: Xatu's resource model assigned 100.21 billion gas to state growth in SSTORE transactions that added no net-new storage slot. Unsigned wrap also made the old aggregate unsafe."
authors: [aubury]
tags: [ethereum, evm, gas, state, correction]
date: 2026-07-17
---

I called **38.6% of Ethereum gas a permanent-storage bill** in February. That sentence was wrong. The table was a research allocation model, not a meter attached to physical state growth, and a quarter of the SSTORE gas it put in `state_growth` came from transactions that added no net-new storage slot at all.

<!-- truncate -->

[The old post](/blog/resource-gas-breakdown/) treated two model buckets, `gas_state_growth` and log history, as gas spent on data that "accumulates forever." It also said the sample covered 12.8 million transactions from February 19–27. Current canonical data puts the cited block range at **13,934,774 transactions from February 20 05:33:47 to February 27 05:41:35 UTC**. The stale count is annoying. The bad noun is the real problem.

Here is how the model classifies SSTORE. I have shortened the current transformation to the three expressions that matter:

```sql
least(toUInt64(100) * count, gas) AS sstore_compute,
least(
  cold_access_count * toUInt64(2100),
  gas - sstore_compute
) AS sstore_access,
gas - sstore_compute - sstore_access AS gas_state_growth
```

That final line is not checking whether a storage slot was created. It puts **every remaining unit of SSTORE gas** into `gas_state_growth`. The source comment calls the bucket "new storage slot / contract creation cost," but the SQL has no original value, current value, new value or storage key. It cannot make that distinction.

This matters because an expensive SSTORE is not automatically state growth. [EIP-2200](https://eips.ethereum.org/EIPS/eip-2200) prices the operation from the original, current and new values. [EIP-2929](https://eips.ethereum.org/EIPS/eip-2929) then adds the cold-slot charge and changes `SSTORE_RESET_GAS`. Updating one existing nonzero slot to another nonzero value still leaves a large remainder after the model's 100-gas compute allocation. The model calls that remainder growth even though the transaction did not add a persistent slot.

I reran the cited block range from the lower-level structlog aggregate. It contains **84,072,287 SSTORE executions** using **421.216531411 Ggas**, where one Ggas is one billion gas. Applying the model's exact formula assigns **400.826745011 Ggas**, or 95.16% of SSTORE gas, to `state_growth`. That reproduces the shape of the old post's 402 Ggas claim.

Then I joined each SSTORE transaction to its canonical final storage diffs. The important part of the query is the grain: SSTORE gas is aggregated by `(block_number, transaction_hash)`, storage diffs are reduced at the same transaction grain, and only then are the transactions classified.

```sql
WITH sstore AS (
  SELECT
    block_number,
    transaction_hash,
    sum(opcode_count) AS sstore_executions,
    sum(
      gas
      - least(toUInt64(100) * opcode_count, gas)
      - least(
          cold_access_count * toUInt64(2100),
          gas - least(toUInt64(100) * opcode_count, gas)
        )
    ) AS model_assigned_growth_gas
  FROM default.canonical_execution_transaction_structlog_agg FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 24496000 AND 24546241
    AND operation = 'SSTORE'
  GROUP BY block_number, transaction_hash
), diffs AS (
  SELECT
    block_number,
    transaction_hash,
    countIf(
      match(from_value, '^(0x)?0*$')
      AND NOT match(to_value, '^(0x)?0*$')
    ) AS new_slot_diffs,
    countIf(
      NOT match(from_value, '^(0x)?0*$')
      AND match(to_value, '^(0x)?0*$')
    ) AS cleared_slot_diffs,
    countIf(
      NOT match(from_value, '^(0x)?0*$')
      AND NOT match(to_value, '^(0x)?0*$')
      AND from_value != to_value
    ) AS updated_slot_diffs
  FROM default.canonical_execution_storage_diffs FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 24496000 AND 24546241
  GROUP BY block_number, transaction_hash
)
SELECT
  multiIf(
    new_slot_diffs > 0, 'has net-new slot diff',
    updated_slot_diffs > 0 AND cleared_slot_diffs = 0, 'updates only',
    cleared_slot_diffs > 0, 'clears/updates',
    'no final storage diff'
  ) AS transaction_class,
  count() AS sstore_transactions,
  sum(model_assigned_growth_gas) AS assigned_growth_gas
FROM sstore
GLOBAL LEFT JOIN diffs USING (block_number, transaction_hash)
GROUP BY transaction_class;
```

The result is blunt. **4,844,607 of 7,967,170 SSTORE transactions had no net-new slot diff.** They still received **100.206725434 Ggas**, almost exactly **25.0%**, of the model's assigned state-growth gas. Updates-only transactions carried 66.40 Ggas, clears/updates carried 28.10 Ggas, and transactions with no final storage diff carried another 5.70 Ggas.

<a href="/img/resource-gas-state-growth-correction.png?v=20260717" target="_blank" rel="noopener noreferrer">
  <img src="/img/resource-gas-state-growth-correction.png?v=20260717" alt="Twenty-five percent of gas assigned to the resource model's state-growth bucket came from SSTORE transactions with no net-new final storage slot. Updates-only transactions carried 66.40 Ggas, clears or updates carried 28.10 Ggas, and transactions with no final storage diff carried 5.70 Ggas." loading="eager" />
</a>

<small><a href="/img/resource-gas-state-growth-correction.png?v=20260717" target="_blank" rel="noopener noreferrer">Open the chart at full resolution.</a> Classification is at transaction grain. A transaction in the 75% cohort had at least one zero-to-nonzero final slot diff, but it could also contain updates and clears. That 75% is not proven physical growth.</small>

The raw diff counts tell the same story from another angle: **11,168,113 zero-to-nonzero final slot diffs, 31,374,568 nonzero-to-nonzero updates and 3,338,217 clears**. Those are transaction-slot final diffs, not opcode executions, so dividing them into the 84.07 million SSTORE count would be fake precision. They are enough to kill the old interpretation. A bucket dominated by residual SSTORE charges is not a count of permanent slots.

There is a second failure hiding in the model, and it explains why I am not replacing 38.6% with a shinier percentage. One CREATE row in the cited range consumed 3,387 gas. The model assigned fixed amounts of 1,000 gas to compute, 250 to address access and 6,700 to history before calculating state growth as the remainder. That remainder is -4,563, but the column is `UInt64`, so it became **18,446,744,073,709,547,053**.

```sql
SELECT
  gas,
  gas_state_growth,
  gas_compute + gas_address_access
    + gas_state_growth + gas_history AS wrapped_uint64_sum,
  toUInt128(gas_compute) + toUInt128(gas_address_access)
    + toUInt128(gas_state_growth) + toUInt128(gas_history) AS wide_sum
FROM mainnet.int_transaction_call_frame_opcode_resource_gas FINAL
WHERE block_number = 24496055
  AND transaction_hash =
    '0x045421edc1ecfbf14646d7044a36f0a0f18b05a12978dbc19d3c734307a4647d'
  AND opcode = 'CREATE';
```

The ordinary `UInt64` component sum wraps back to **3,387**, so the row passes the model's "components sum to gas" check. Widening before addition gives **18,446,744,073,709,555,003**, exactly `2^64 + 3,387`. Across the full opcode window, the wide component sum exceeds opcode gas by exactly `2^64`. A plausible-looking aggregate can survive an impossible row because both the bad value and the check wrap at the same boundary.

The downstream transaction resource table currently carries more wrapped component rows, so its broad percentages are not a safe correction path either. Casting every component to `UInt128` before summing exposes the problem immediately; the canonical transaction table's total receipt gas stays in the normal trillion-gas range. I am not going to turn a broken aggregate into a replacement headline.

The corrected statement is narrower and uglier: this was a gas-allocation model, and `state_growth` used the SSTORE remainder as a proxy. In the exact window I published, one quarter of that proxy sat in transactions that produced no net-new storage slot. The old **38.6% permanent-storage claim is retracted**.
