---
slug: prysm-attestation-packing
title: "Prysm packed eight attestations where everyone else packed one"
description: "Across five complete days on Platåberget, 5,964 of 5,965 Prysm-mapped blocks hit the eight-attestation cap. Its median captured block was 2.86× larger than any other mapped client's."
authors: [aubury]
tags: [ethereum, prysm, attestations, gloas, devnet, xatu]
date: 2026-08-27
---

My first query said Prysm put about 150 attestations into blocks whose hard limit is eight. That was obviously a row-grain bug, not a consensus break. Xatu elaborates one on-chain Electra attestation into its committee-level pieces, so a plain `count()` is nonsense here.

After collapsing those pieces back to `position_in_block`, the result was less impossible and much more interesting. Over five complete UTC days on Platåberget, **5,964 of 5,965 blocks proposed by mapped Prysm validators used all eight attestation positions**. Every other mapped consensus client had a median of one.

<!-- truncate -->

## Eight, almost every time

The window runs from August 21 00:00 through August 26 00:00 UTC. It contains 35,675 canonical blocks. The public devnet inventory maps the 84,000 genesis validator indices to consensus clients in fixed ranges; 35,280 blocks came from those mapped indices, including 5,965 Prysm blocks. I kept another 395 post-genesis proposer blocks out of the client comparison because the frozen range map does not identify them.

Prysm hit the protocol cap in **99.983%** of its mapped blocks. Across the other five clients, 573 of 29,315 blocks hit eight, or **1.955%**. Their individual cap rates ranged from 0.825% to 3.784%.

This is the exact query path behind those numbers. The 42 labels are the public inventory's adjacent 2,000-validator ranges. I checked that the range ledger was unchanged between the network's August 13 inventory and the August 26 buildoor update before using it.

```python
from ethpandaops import clickhouse

client_labels = [
    "prysm", "lodestar", "lighthouse", "teku", "nimbus",
    "prysm", "lodestar", "lighthouse", "teku", "nimbus",
    "prysm", "lodestar", "lighthouse", "teku", "nimbus",
    "prysm", "lodestar", "lighthouse", "teku", "nimbus",
    "prysm", "lodestar", "lighthouse", "teku", "nimbus",
    "prysm", "lodestar", "lighthouse", "teku", "nimbus",
    "grandine", "prysm", "grandine", "lodestar", "grandine",
    "lighthouse", "grandine", "teku", "grandine", "nimbus",
    "grandine", "grandine",
]
keys = ",".join(str(i) for i in range(42))
labels = ",".join(repr(client) for client in client_labels)
client = (
    "transform(intDiv(toUInt32(b.proposer_index), 2000), "
    f"[{keys}], [{labels}], 'unknown')"
)

result = clickhouse.query("clickhouse-raw", f"""
WITH per_position AS (
  SELECT
    block_root,
    block_slot,
    position_in_block,
    any(slot) AS attested_slot,
    count() AS committee_rows,
    length(arrayDistinct(arrayFlatten(groupArray(validators))))
      AS position_unique_validators
  FROM `glamsterdam-devnet-8`.canonical_beacon_elaborated_attestation FINAL
  WHERE meta_network_name = 'glamsterdam-devnet-8'
    AND slot_start_date_time >= toDateTime('2026-08-20 23:00:00')
    AND block_slot_start_date_time >= toDateTime('2026-08-21 00:00:00')
    AND block_slot_start_date_time <  toDateTime('2026-08-26 00:00:00')
  GROUP BY block_root, block_slot, position_in_block
), per_block AS (
  SELECT
    p.block_root,
    count() AS included_attestations,
    sum(p.position_unique_validators) AS position_unique_validator_sum,
    countIf(p.block_slot - p.attested_slot >= 2) AS older_attestations
  FROM per_position AS p
  GROUP BY p.block_root
), per_block_unique AS (
  SELECT
    block_root,
    length(arrayDistinct(arrayFlatten(groupArray(validators))))
      AS block_unique_validators
  FROM `glamsterdam-devnet-8`.canonical_beacon_elaborated_attestation FINAL
  WHERE meta_network_name = 'glamsterdam-devnet-8'
    AND slot_start_date_time >= toDateTime('2026-08-20 23:00:00')
    AND block_slot_start_date_time >= toDateTime('2026-08-21 00:00:00')
    AND block_slot_start_date_time <  toDateTime('2026-08-26 00:00:00')
  GROUP BY block_root
)
SELECT
  {client} AS proposer_client,
  count() AS canonical_blocks,
  quantileExact(0.5)(a.included_attestations) AS p50_attestations,
  countIf(a.included_attestations = 8) AS blocks_at_cap,
  100.0 * blocks_at_cap / canonical_blocks AS blocks_at_cap_pct,
  100.0 * sum(a.older_attestations)
    / sum(a.included_attestations) AS older_attestation_pct,
  100.0 * (
    sum(a.position_unique_validator_sum) - sum(u.block_unique_validators)
  ) / sum(a.position_unique_validator_sum) AS repeated_mention_pct,
  quantileExactIf(0.5)(
    b.block_total_bytes,
    b.block_total_bytes IS NOT NULL
  ) AS p50_block_bytes
FROM `glamsterdam-devnet-8`.canonical_beacon_block AS b FINAL
GLOBAL INNER JOIN per_block AS a ON b.block_root = a.block_root
GLOBAL INNER JOIN per_block_unique AS u ON b.block_root = u.block_root
WHERE b.meta_network_name = 'glamsterdam-devnet-8'
  AND b.slot_start_date_time >= toDateTime('2026-08-21 00:00:00')
  AND b.slot_start_date_time <  toDateTime('2026-08-26 00:00:00')
  AND b.proposer_index < 84000
GROUP BY proposer_client
ORDER BY proposer_client
""")
print(result.to_string(index=False))
```

The grain checks mattered. The 35,675 selected rows had 35,675 unique slots and roots. Every `(block_root, position_in_block)` resolved to one attestation data shape. Counting elaborated rows instead of positions would have reported an average of 153.3 "attestations" for Prysm, which is how I got the impossible first result.

<img
  src="/img/prysm-attestation-packing.png"
  alt="Horizontal bars show Prysm at a median of eight included attestations per canonical block while Teku, Nimbus, Lighthouse, Lodestar and Grandine each have a median of one. Callouts show that 86.7% of Prysm's positions were at least two slots old, 4.78% of validator mentions repeated across positions, and Prysm's median captured block size was 5,970 bytes."
  loading="eager"
/>

## The seven extra positions were mostly old

Prysm did not merely use more positions. **41,366 of its 47,717 included attestation positions were at least two slots old**, or 86.690%. The other mapped clients ranged from 20.645% to 35.539%.

There was also much more overlap inside the block. I took the unique validator set for each on-chain position, summed those position-level counts, then compared the sum with the unique validator set across the whole block. Prysm produced **5,662,697 repeated validator mentions**, 4.782% of its position-level total. The other five clients combined produced 49,137, and no individual client exceeded 0.083%.

That comparison does not say every repeat was rewardless. A repeated validator can sit behind different source, target, or head correctness flags, and the Xatu row alone does not say which participation flags were already set in the pre-state. It does show the exact block shape the Prysm fix is aimed at: many more old attestation positions, with far more validator overlap between them.

The bytes moved with the shape. Prysm's median `block_total_bytes` was **5,970 bytes**. The other client medians ranged from 1,763 to 2,086 bytes, so Prysm's median was 2.86 times the largest of them. These are captured serialized block bytes, not measured wire traffic, compressed peer bandwidth, CPU, or disk cost.

## The old packer scored candidates in isolation

Prysm [PR #17416](https://github.com/OffchainLabs/prysm/pull/17416), opened on August 26, describes why the cap kept filling. The old Electra packer scored each candidate aggregate against the same pre-block participation state, sorted those standalone scores, then took the best eight. It did not rescore the remaining candidates after selecting the first one. An aggregate could therefore look valuable even when an earlier selection in the same block had already covered the same validator flags.

Commit [`fd152d3`](https://github.com/OffchainLabs/prysm/commit/fd152d3497255d35791864cfddf3dabd3d03ed0e) replaces that sort-and-truncate step with a greedy marginal-reward selector. It mutates a shadow copy of the participation bits after each choice, then stops when the best remaining candidate adds nothing. The current consensus spec still caps post-Electra blocks at [`MAX_ATTESTATIONS_ELECTRA = 8`](https://github.com/ethereum/consensus-specs/blob/cf65c29a2590b8f5d43b6a26aee9f2293ed560f1/presets/mainnet/electra.yaml#L17-L18).

The PR was open and unmerged at this post's cutoff. My data window ends before its commit, so this is a measurement of the old shape, not a before-and-after deployment test.

## A public block explorer saw the same blocks

I cross-checked six exact roots through [Platåberget's public Dora](https://dora.plataberget.ethpandaops.io/). The proposer indices, roots, client graffiti, and body attestation counts matched Xatu: the Prysm sample at slot 54,105 had eight, while exact Grandine, Lighthouse, Lodestar, Nimbus, and Teku samples had one. A second Teku sample at slot 89,999 had two.

Dora's proposer-name filter returned 5,960 Prysm-named blocks in the same slot window rather than the 5,965 blocks assigned by the public validator-index map. Within that name-filtered set, 5,959 had eight attestations and the same single block had five. I kept the two denominators separate instead of averaging them; name filtering and index assignment are different source paths.

I did not publish an ETH reward-loss number. The devnet's raw block-reward export reported zero for the attestation component across this window, and reconstructing exact marginal reward requires ordered participation flags from the pre-state. The code change says the extra candidates could add zero reward. The data here says how often Prysm filled the cap, how old those positions were, how much they overlapped, and how many serialized bytes came with them.

That is enough to make the bug visible. One client used all eight slots in virtually every block. Everyone else mostly stopped at one.
