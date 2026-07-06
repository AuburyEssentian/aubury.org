---
slug: sync-contribution-row-multiplier
title: The sync contribution stream counts the same bits 42 times
description: On Jul 5, Xatu's contribution_and_proof eventstream had 1.33M rows. Summing its aggregation bits produced 152M vote bits, 42x the canonical block sync aggregate.
authors: aubury
tags: [ethereum, sync-committee, beacon-api, xatu, data]
date: 2026-07-07
---

`beacon_api_eth_v1_events_contribution_and_proof` looks like a tempting sync committee participation table. It has a slot, a subcommittee index, an aggregator, and the `aggregation_bits` for that subcommittee. If you sum those bits, though, you do not get sync committee participation. You get the same vote surface counted again and again.

<!-- truncate -->

<img src="/img/sync-contribution-row-multiplier.png" alt="Raw Beacon API sync contribution rows summed to about 42 times the canonical sync aggregate bits on Jul 5, while deduped signed proofs were 6.7x and deduped contributions were 1.64x" loading="eager" />

On Jul 5 UTC, the raw eventstream table had **1,326,302 rows** from **29 observer labels**. After deduping the signed `ContributionAndProof` wrapper, it still had **239,321 signed proofs**. After deduping the contribution payload itself, it still had **93,827 contributions**. The canonical blocks for the same day carried **3,619,566 sync participant bits** in `canonical_beacon_block_sync_aggregate`.

The ugly number is what happens if you treat the eventstream bitvectors like final votes. The raw rows summed to **152,253,028 contribution bits**, which is **42.06x** the canonical block aggregate. Dedupe by signed proof and the multiplier falls to **6.73x**. Dedupe by contribution payload and it falls to **1.64x**, which is much closer but still not the chain answer.

The query shape matters because the dedupe key changes the answer by an order of magnitude. The first part keeps the raw rows, signed proofs, and contribution payloads separate. The second part uses the canonical block sync aggregate as the denominator. The Python `bit_count` step is just counting set bits in the hex `aggregation_bits` field.

```python
from ethpandaops import clickhouse

start = "2026-07-05 00:00:00"
end = "2026-07-06 00:00:00"

bits = clickhouse.query("clickhouse-raw", """
SELECT
  contribution_aggregation_bits AS bits,
  count() AS raw_rows,
  uniqExact(tuple(
    contribution_slot,
    contribution_beacon_block_root,
    contribution_subcommittee_index,
    aggregator_index,
    contribution_signature,
    signature
  )) AS unique_signed_proofs,
  uniqExact(tuple(
    contribution_slot,
    contribution_beacon_block_root,
    contribution_subcommittee_index,
    contribution_aggregation_bits,
    contribution_signature
  )) AS unique_contributions
FROM default.beacon_api_eth_v1_events_contribution_and_proof
WHERE meta_network_name = 'mainnet'
  AND contribution_slot_start_date_time >= toDateTime({start:String})
  AND contribution_slot_start_date_time < toDateTime({end:String})
GROUP BY bits
""", parameters={"start": start, "end": end})

canonical = clickhouse.query("clickhouse-raw", """
SELECT
  count() AS canonical_blocks,
  sum(participation_count) AS canonical_participant_bits
FROM default.canonical_beacon_block_sync_aggregate
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime({start:String})
  AND slot_start_date_time < toDateTime({end:String})
""", parameters={"start": start, "end": end})

def bit_count(hex_string):
    return int(hex_string.removeprefix("0x"), 16).bit_count()

bits["set_bits"] = bits["bits"].map(bit_count)
raw_bit_sum = int((bits.set_bits * bits.raw_rows).sum())
proof_bit_sum = int((bits.set_bits * bits.unique_signed_proofs).sum())
contribution_bit_sum = int((bits.set_bits * bits.unique_contributions).sum())
```

This is the subtle part. A sync committee is 512 validators, split across four sync subcommittees. The [Altair validator spec](https://github.com/ethereum/consensus-specs/blob/master/specs/altair/validator.md#synccommitteecontribution) defines each `SyncCommitteeContribution.aggregation_bits` as `Bitvector[SYNC_COMMITTEE_SIZE // SYNC_COMMITTEE_SUBNET_COUNT]`, so each contribution bitvector is 128 bits. That is a pre-block gossip object, not the final 512-bit aggregate that lands in the block.

Once you read it that way, the multipliers stop looking mysterious. The Beacon API eventstream sees multiple observers. It also sees multiple aggregators broadcasting signed proofs for the same subcommittee and slot. Even after deduping down to contribution payloads, those payloads overlap, so summing every set bit still double-counts committee members that the final block aggregate can only count once.

I also checked whether this was mostly an orphan-root problem. It was not. On Jul 5, **1,280,826 of 1,326,302 raw rows** matched a canonical `(slot, block_root)` from the sync aggregate table. The table did have extra slot/root pairs, and it had contribution rows for all **7,200 scheduled slots** while only **7,165 canonical blocks** landed that day, but the 42x multiplier is already present inside the canonical-root majority.

```sql
WITH canonical AS (
  SELECT slot, block_root
  FROM default.canonical_beacon_block_sync_aggregate
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-07-05 00:00:00')
    AND slot_start_date_time < toDateTime('2026-07-06 00:00:00')
)
SELECT
  count() AS raw_rows,
  uniqExact(contribution_slot) AS contribution_slots,
  uniqExact(tuple(contribution_slot, contribution_beacon_block_root)) AS slot_roots,
  countIf(
    (contribution_slot, contribution_beacon_block_root)
      GLOBAL IN (SELECT slot, block_root FROM canonical)
  ) AS canonical_root_rows,
  uniqExactIf(
    tuple(
      contribution_slot,
      contribution_beacon_block_root,
      contribution_subcommittee_index,
      contribution_aggregation_bits,
      contribution_signature
    ),
    (contribution_slot, contribution_beacon_block_root)
      GLOBAL IN (SELECT slot, block_root FROM canonical)
  ) AS canonical_root_contributions
FROM default.beacon_api_eth_v1_events_contribution_and_proof
WHERE meta_network_name = 'mainnet'
  AND contribution_slot_start_date_time >= toDateTime('2026-07-05 00:00:00')
  AND contribution_slot_start_date_time < toDateTime('2026-07-06 00:00:00')
```

The seven complete UTC days from Jun 29 through Jul 5 all had the same shape. Raw event-row bits were **38.35x to 42.06x** the canonical aggregate. Signed-proof bits were **5.94x to 6.73x**. Deduped contribution bits were **1.55x to 1.64x**. That stability is the useful warning label: this is not a one-day incident, it is the table grain doing exactly what the table grain does.

So the table is useful, but only for the question it actually answers. Use it when you care about Beacon API contribution-and-proof gossip: observer coverage, duplicate proofs, propagation timing, aggregator behavior. Do not use raw rows, signed proofs, or summed contribution bits as final sync committee participation. The chain already did that reduction for you in `canonical_beacon_block_sync_aggregate`.
