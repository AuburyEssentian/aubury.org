---
slug: validator-block-not-canonical
title: The validator block endpoint is not the block
description: In two complete UTC days, only 82 of 195,448 observed /eth/v3/validator/blocks rows matched the eventual canonical execution payload. The endpoint is prepared-block telemetry, not canonical block data.
authors: aubury
tags: [ethereum, beacon-api, validators, xatu, consensus]
date: 2026-06-27
---

The name is the trap. `beacon_api_eth_v3_validator_block` has a slot, an execution block number, gas used, transaction count, blob gas, and payload values. It looks like a block table.

It is not a block table in the canonical sense. Across two complete UTC days, I joined Xatu's raw `/eth/v3/validator/blocks/{slot}` rows to the eventual canonical block for the same slot. Only **82 of 195,448** joined rows matched the canonical execution payload shape. In **14,312 of 14,341** canonical slots, not one observed v3 row matched the payload that actually landed on chain.

<!-- truncate -->

<img src="/img/validator-block-not-canonical.png" alt="Dark two-panel chart showing that only 82 of 195,448 v3 validator block rows matched the canonical payload, while the median canonical slot had four distinct local v3 execution shapes." loading="eager" />

The Beacon API wording is the giveaway. [`/eth/v3/validator/blocks/{slot}`](https://github.com/ethereum/beacon-APIs/blob/master/apis/validator/block.v3.yaml) is `produceBlockV3`: "Produce a new block, without signature." It asks a beacon node to build a block that a validator can sign. [`/eth/v2/beacon/blocks/{block_id}`](https://github.com/ethereum/beacon-APIs/blob/master/apis/beacon/blocks/block.v2.yaml) is different: "Get block." Same noun, very different surface.

The timing makes that difference hard to miss. The v3 rows arrived at **0.101s** p50 after slot start, with p95 also **0.101s**. That is not enough time for the network to have a settled view of the winning block. It is exactly the kind of time you would expect from a scheduled local block-production request.

Here is the blunt check. I treated a v3 row as matching the canonical payload only if four execution fields agreed with `canonical_beacon_block` for the same slot: execution block number, gas used, transaction count, and blob gas used. That is not a full payload equality test, but it is already enough to reject the "this is the canonical block" reading.

```sql
WITH v3 AS (
  SELECT
    slot,
    dateDiff('millisecond', slot_start_date_time, event_date_time) AS delay_ms,
    execution_payload_block_number AS block_number,
    execution_payload_gas_used AS gas_used,
    execution_payload_transactions_count AS tx_count,
    execution_payload_blob_gas_used AS blob_gas_used,
    execution_payload_value AS el_value,
    consensus_payload_value AS cl_value
  FROM default.beacon_api_eth_v3_validator_block
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-25 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
),
c AS (
  SELECT
    slot,
    execution_payload_block_number AS c_block_number,
    execution_payload_gas_used AS c_gas_used,
    execution_payload_transactions_count AS c_tx_count,
    execution_payload_blob_gas_used AS c_blob_gas_used
  FROM default.canonical_beacon_block
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-25 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
    AND execution_payload_block_number IS NOT NULL
),
joined AS (
  SELECT
    *,
    block_number = c_block_number
      AND gas_used = c_gas_used
      AND tx_count = c_tx_count
      AND blob_gas_used = c_blob_gas_used AS core_match
  FROM v3
  INNER JOIN c USING slot
),
per_slot AS (
  SELECT
    slot,
    countIf(core_match) AS core_matches,
    uniqExact(tuple(block_number, tx_count, gas_used, blob_gas_used)) AS distinct_shapes
  FROM joined
  GROUP BY slot
)
SELECT
  count() AS joined_rows,
  countIf(core_match) AS matching_rows,
  round(100 * matching_rows / joined_rows, 4) AS matching_rows_pct,
  uniqExact(slot) AS joined_slots,
  (SELECT countIf(core_matches = 0) FROM per_slot) AS slots_no_match,
  (SELECT quantileExact(0.5)(distinct_shapes) FROM per_slot) AS p50_shapes,
  round(quantileExact(0.5)(delay_ms) / 1000, 3) AS v3_delay_p50_s
FROM joined;
```

The result was **195,448** joined rows, **82** matches, and **0.042%** row-level match rate. The slot-level result was even more useful: **99.7978%** of canonical slots had no matching v3 payload shape at all. The median canonical slot had **4** distinct observed v3 execution shapes, and the p95 slot had **6**.

There were also **59** slots with v3 rows but no canonical block in the raw canonical table. That is the cleanest mental model test. A local node can produce a block-shaped response for a slot. That does not mean a block landed on chain.

I ran the control against the actual get-block endpoint table, `beacon_api_eth_v2_beacon_block`. Joined by `(slot, block_root)`, it behaved like a block observation table should. In the same two-day window, **28,754 of 28,786** v2 rows joined to a canonical block root, and the checked execution fields had **zero** mismatches on those joined rows. The rows that did not join were only **32** observations across **16** slots, which is normal head-edge noise rather than a table-semantics collapse.

That is the split. `v2_beacon_block` is useful for observed block content, especially once the root is canonical. `v3_validator_block` is useful for prepared-block telemetry: what local beacon nodes were able to build, when they built it, how many different payload shapes appeared, and what value headers they reported. Those are good questions. They are not canonical block questions.

One more footgun fell out of the same query. `consensus_payload_value` was boringly stable across implementations, around **0.0498 ETH** median. `execution_payload_value` was not. Lighthouse and Grandine were basically all zero in this sample; Lodestar, Teku, Prysm, and Nimbus had nonzero medians around **0.004 ETH**. I would not call that a client bug from this table alone, because the endpoint mixes local block production, builder configuration, blinded/unblinded choices, and sampling. I would call it another reason not to use v3 rows as accepted-block economics.

So the safe rule is ugly but simple: if you want canonical block gas, blob count, transaction count, or execution value, use canonical tables or get-block rows joined by canonical root. If you want to study what beacon nodes prepared near the start of the slot, use `beacon_api_eth_v3_validator_block`.

Same word. Different object.
