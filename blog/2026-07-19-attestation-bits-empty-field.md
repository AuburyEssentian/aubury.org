---
slug: attestation-bits-empty-field
title: "The attestation aggregation_bits field contains no bits"
description: "Ordinary Electra attestation gossip uses SingleAttestation, which has no aggregation_bits field, but Xatu emitter paths still split the same message ID into empty-string and 0x values."
authors: aubury
tags: [ethereum, attestations, electra, libp2p, xatu, data-quality]
date: 2026-07-19
---

The aggregate-and-proof table had three encodings for a real bitlist. Its ordinary-attestation sibling manages something stranger: the column is present, but the gossip object has no bitlist. In 15 minutes, **1,960,559 message IDs** still split into two values because one emitter spells empty as `""` and another spells it `0x`.

<!-- truncate -->

<a href="/img/attestation-bits-empty-field.png">
  <img src="/img/attestation-bits-empty-field.png" alt="Dark infographic showing that 95.18% of ordinary attestation message IDs split between an empty string and 0x even though Electra SingleAttestation has no aggregation bits field" loading="eager" />
</a>

## Two spellings for nothing

This started as the obvious follow-up to [the aggregate encoding mess](/blog/aggregate-bits-three-encodings/). I ran the same content-ID gate against `default.libp2p_gossipsub_beacon_attestation`, using a complete 15-minute window on July 18. The table had **9,578,165 observer rows** for **2,059,867 content-derived message IDs**.

Grouping each ID by `aggregation_bits` produced **4,020,426 `(message_id, field value)` pairs**. In other words, 95.178912% of the IDs acquired a second value even though slot, committee, attester, voted root, source checkpoint and target checkpoint agreed exactly.

```sql
WITH per_id AS (
  SELECT
    message_id,
    count() AS observation_rows,
    uniqExact(aggregation_bits) AS bit_field_values,
    uniqExact(meta_client_implementation) AS implementations,
    uniqExact(tuple(
      slot,
      attesting_validator_committee_index,
      attesting_validator_index,
      beacon_block_root,
      source_epoch,
      source_root,
      target_epoch,
      target_root
    )) AS semantic_values
  FROM default.libp2p_gossipsub_beacon_attestation FINAL
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-07-18 12:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-18 12:15:00')
  GROUP BY message_id
)
SELECT
  count() AS message_ids,
  sum(observation_rows) AS observation_rows,
  sum(bit_field_values) AS message_field_pairs,
  countIf(bit_field_values > 1) AS split_ids,
  round(100 * split_ids / message_ids, 6) AS split_pct,
  countIf(semantic_values > 1) AS semantic_disagreements,
  countIf(implementations >= 3) AS ids_seen_by_three_emitters
FROM per_id;
```

The two values were not competing bitsets. Tysm stored the empty string, as did the Teku sidecar. The Lighthouse sidecar stored `0x`. Among the **64,377 IDs captured by all three paths**, Tysm and Teku agreed on `""` every time while Lighthouse used `0x` every time.

Four other complete 15-minute checks that day put the split share at **98.31%, 96.85%, 95.18% and 94.19%**. That movement tracks which capture paths overlapped in each window; it is not an attestation trend. Every window had zero disagreements on the non-placeholder fields.

## SingleAttestation has no aggregation bits

Since Electra's EIP-7549 changes, the `beacon_attestation_{subnet_id}` topic propagates [`SingleAttestation`](https://github.com/ethereum/consensus-specs/blob/8c12caee279d77b322446d33440b37479117dcde/specs/electra/p2p-interface.md#modified-beacon_attestation_subnet_id). The container has four fields: `committee_index`, `attester_index`, `data` and `signature`. [`aggregation_bits` is not one of them](https://github.com/ethereum/consensus-specs/blob/8c12caee279d77b322446d33440b37479117dcde/specs/electra/beacon-chain.md#singleattestation).

Aggregated attestations still have a real bitlist. That is why the three representations in the previous post were a serialization problem. Ordinary gossip is different: one validator index travels directly in the message, so there is no participant bitlist to normalize.

The same fork change leaves a second fossil in the table. `committee_index` comes from `AttestationData.index`, which EIP-7549 requires to be zero. Xatu's ClickHouse flattener writes that zero as an empty string. The real committee lands in `attesting_validator_committee_index`.

```sql
SELECT
  meta_client_implementation AS emitter,
  if(aggregation_bits = '', '<empty string>', aggregation_bits) AS stored_value,
  count() AS rows,
  uniqExact(message_id) AS message_ids,
  countIf(committee_index = '') AS empty_legacy_data_index_rows,
  countIf(attesting_validator_committee_index = '') AS empty_actual_committee_rows,
  uniqExact(attesting_validator_committee_index) AS actual_committees,
  countIf(attesting_validator_index IS NULL) AS null_attester_rows
FROM default.libp2p_gossipsub_beacon_attestation FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-18 12:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-18 12:15:00')
GROUP BY emitter, stored_value
ORDER BY emitter;
```

All **9,578,165 rows** had an empty legacy `committee_index`. None had an empty actual committee or a null attester index. Across the two broad emitter cohorts, the actual field covered all 64 attestation subnets. A query using the shorter-looking `committee_index` column would conclude that every ordinary attestation lacked a committee.

## The raw payload has nowhere to hide a bitlist

Xatu v1.22's [raw gossip payload archive](https://github.com/ethpandaops/xatu/releases/tag/v1.22.0) held exact message ID `0000cb806a7bb8d1115919519495d88b289a758b` under `beacon_attestation_1`. The compressed payload was 224 bytes with SHA-256 `28e6a51b133fa21ac861e23bb4b3528601cec306e65b6dc04ba0fa6c22c35793`.

```sql
SELECT
  message_id,
  topic_name,
  message_size,
  length(message_data) AS stored_bytes,
  hex(SHA256(message_data)) AS payload_sha256,
  hex(message_data) AS payload_hex
FROM default.libp2p_gossipsub_message_payload FINAL
WHERE meta_network_name = 'mainnet'
  AND wallclock_slot_start_date_time >= toDateTime('2026-07-18 12:00:00')
  AND wallclock_slot_start_date_time <  toDateTime('2026-07-18 12:15:00')
  AND message_id = '0000cb806a7bb8d1115919519495d88b289a758b';
```

Snappy decompression produced exactly 240 bytes. Decoding the fixed SSZ layout gave:

- bytes 0-7: committee index **1**
- bytes 8-15: attester index **117,414**
- bytes 16-143: `AttestationData`, including slot **14,796,039** and its required zero data index
- bytes 144-239: the 96-byte BLS signature

There is no offset left for `aggregation_bits`, and the decoded values match the parsed table row. This is an independent check against the adapter code rather than another grouping of the same flattened column.

The code explains both empty spellings. [Tysm constructs the compatibility event with `AggregationBits: ""`](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/clmimicry/gossipsub_single_attestation.go#L28-L44). [The Teku sidecar writes an empty string for a single attestation](https://github.com/ethpandaops/temu/blob/1a29f4a139247147b80eae6260b505b5b7f375b3/plugins/xatu/src/main/java/tech/pegasys/teku/plugin/xatu/XatuSidecarCore.java#L270-L293). [The Lighthouse sidecar explicitly writes `0x` because single attestations have no aggregation bits](https://github.com/ethpandaops/dimhouse/blob/807fccbfa148f7fb7a6202a1ee38ef1c0422702e/overlay/xatu/src/observer_ffi.rs#L331-L388).

So this is not a client disagreement, an empty committee or a participant-count bug on Ethereum. It is one compatibility schema carrying a pre-Electra field through three adapters. The sample is an instrumented gossip surface, not a validator census or a count of attestations included onchain.

There is no useful normalization trick here. For `SingleAttestation` rows, the honest value is absent or null, and the actual committee field needs the obvious name. Until the schema says that plainly, grouping ordinary gossip by `aggregation_bits` turns two ways of writing nothing into two different facts.
