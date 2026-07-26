---
slug: mev-boost-slashing-proof-delay
title: "The $20M mev-boost exploit's slashing proof waited 15 hours"
description: "Eighteen of Ethereum's nineteen canonical proposer-slashing proofs landed within two slots. The April 2023 mev-boost relay exploit waited 4,474."
authors: [aubury]
tags: [ethereum, mev, mev-boost, validators, slashings, xatu]
date: 2026-07-15
---

The slashing proof for the April 2023 mev-boost relay exploit did not land in the next block, or even the next hour. It was included **4,474 slots later: 14 hours, 54 minutes, and 48 seconds**. Every other canonical proposer-slashing proof on Ethereum landed one or two slots after the conflicting header.

<!-- truncate -->

This is the attack where a malicious proposer extracted roughly $20 million from sandwich bots. The [Flashbots post-mortem](https://collective.flashbots.net/t/post-mortem-april-3rd-2023-mev-boost-relay-incident-and-related-timing-issue/1540) says the proposer requested a builder header, replaced its parent and state roots with zero, signed it, and sent it back to the ultra sound relay. The relay's beacon nodes rejected the invalid block, but the relay still revealed the body. The proposer then pulled apart the searchers' bundles and published its own profitable block at slot **6,137,846**.

The recently added `canonical_beacon_block_proposer_slashing` table keeps the two signed headers inside each proof. I reduced it to the semantic proof key rather than counting raw rows, then measured from the signed-header slot to the slot that included the evidence.

```sql
WITH
  concat('0x', repeat('0', 64)) AS zero_root,
  proofs AS (
  SELECT DISTINCT
    block_root,
    signed_header_1_message_proposer_index AS validator_index,
    slot - signed_header_1_message_slot AS delay_slots,
    signed_header_1_message_parent_root AS h1_parent,
    signed_header_1_message_state_root AS h1_state,
    signed_header_2_message_parent_root AS h2_parent,
    signed_header_2_message_state_root AS h2_state
  FROM default.canonical_beacon_block_proposer_slashing FINAL
  WHERE meta_network_name = 'mainnet'
)
SELECT
  count() AS proofs,
  uniqExact(block_root) AS unique_inclusion_blocks,
  uniqExact(validator_index) AS unique_validators,
  countIf(delay_slots = 1) AS one_slot,
  countIf(delay_slots = 2) AS two_slots,
  countIf(delay_slots > 2) AS later,
  max(delay_slots) AS max_delay_slots,
  countIf(h1_parent = h2_parent) AS same_parent,
  countIf(
    (h1_parent = zero_root AND h1_state = zero_root)
    OR (h2_parent = zero_root AND h2_state = zero_root)
  ) AS zero_parent_and_state
FROM proofs;
```

The result was blunt: **16 proofs at one slot, two proofs at two slots, and this one proof at 4,474 slots**. Exactly **one** evidence pair contained a signed zero-parent-and-state header. All 19 inclusion blocks, proofs, and validator indices were unique.

<a href="/img/mev-boost-slashing-proof-delay.png"><img src="/img/mev-boost-slashing-proof-delay.png" alt="Log-scale comparison of Ethereum proposer-slashing proof inclusion delays. Sixteen proofs landed after one slot, two after two slots, and the April 2023 mev-boost exploit proof after 4,474 slots or 14 hours 54 minutes 48 seconds." loading="eager" /></a>

That outlier is not merely close to the relay attack. It is the relay attack's evidence object.

I fetched canonical slot **6,142,320** from the block archive and decoded its sole proposer slashing independently of the Xatu projection. The first signed header has the attacker's slot and validator index, a nonzero body root, and all-zero parent and state roots. The second header's parent and state roots match the canonical block at slot 6,137,846.

```python
from ethpandaops import block_archive

block = block_archive.get_block_json(
    "mainnet",
    6142320,
    "0x44bc8ac7f0c9b1bf9a6fb2d39c2824bde65b89ea8ae9248ec5144f35efcdf2cb",
)
proof = block["block"]["message"]["body"]["proposer_slashings"][0]

print(proof["signed_header_1"]["message"])
# slot: 6137846
# proposer_index: 552061
# parent_root: 0x0000...0000
# state_root:  0x0000...0000
# body_root:   0x8271...5db7
```

The field shape is unusual even within this tiny population. In **18 of the 19** proofs, both signed headers built on the same parent. Their state and body roots differed.

The April 2023 pair is the only one with different parent roots because one parent is zero. For every proof, exactly one header's parent and state roots matched the canonical block for the offense slot; the canonical copy was header one six times and header two thirteen times, so header order itself carries no meaning.

The protocol is less fussy than a block-validity check. [`process_proposer_slashing`](https://github.com/ethereum/consensus-specs/blob/master/specs/phase0/beacon-chain.md#proposer-slashings) checks that the two headers name the same slot and proposer, that they differ, that the validator is still slashable, and that both signatures verify. It does not require the parent or state root to describe a block a beacon node would accept. That is exactly why the signed zero-root header could fail as a block and still work as slashing evidence.

As a final state check, I looked up all 19 proposer indices in the latest `canonical_beacon_validators` snapshot. All **19 are marked `slashed`**. The attack validator is now `withdrawal_done`, with exit epoch 191,952 and withdrawable epoch 200,139, matching the penalty path rather than a stray historical row.

The data cannot tell me why this proof took 15 hours to reach a block. It does pin down the sequence. Flashbots' timeline had the first public write-up at 06:11 UTC and a relay patch at 10:06. The canonical slashing proof landed at 14:24, long after the attack was understood.

That is the useful distinction. A slashable signature is not an automatic onchain alarm. Someone still has to construct the proof, gossip it, and get it included.
