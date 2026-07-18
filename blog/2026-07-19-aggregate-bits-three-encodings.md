---
slug: aggregate-bits-three-encodings
title: "One gossip message became three bit strings"
description: "The same aggregate-and-proof message ID produced three aggregation_bits encodings, depending on which Xatu emitter path recorded it."
authors: aubury
tags: [ethereum, attestations, libp2p, xatu, data-quality]
date: 2026-07-19
---

`aggregation_bits` looks like a field you can group across clients. I tried that, and one gossip payload turned into three strings.

The participants had not changed. The Xatu emitter path had. In one hour, **41,441 of 247,296** content-derived message IDs carried more than one stored `aggregation_bits` value, while every other parsed attestation field agreed.

<!-- truncate -->

<a href="/img/aggregate-bits-three-encodings.png">
  <img src="/img/aggregate-bits-three-encodings.png" alt="Infographic showing one aggregate-and-proof message ID represented as a short Tysm bit string, a zero-padded Lighthouse bit string, and a Teku SSZ bitlist with one delimiter bit" loading="eager" />
</a>

## One payload, three strings

I bounded the check to July 17 from 12:00 to 13:00 UTC. The table had 8,122,792 observer rows for 247,296 unique `beacon_aggregate_and_proof` message IDs. Grouping the same rows by `(message_id, aggregation_bits)` produced 293,165 pairs, a **1.185482x split multiplier**.

The useful control was everything except the bit string. Slot, committee, aggregator, voted block root, source checkpoint and target checkpoint had zero disagreements inside a message ID. The split was isolated to `aggregation_bits`.

```sql
SELECT
  count() AS message_ids,
  sum(row_count) AS observation_rows,
  sum(bit_variants) AS message_bit_pairs,
  countIf(bit_variants > 1) AS messages_with_multiple_bit_strings,
  countIf(nonbit_variants > 1) AS messages_with_other_semantic_disagreement,
  max(bit_variants) AS max_bit_strings_per_message
FROM (
  SELECT
    message_id,
    count() AS row_count,
    uniqExact(aggregation_bits) AS bit_variants,
    uniqExact(tuple(
      slot, committee_index, aggregator_index, beacon_block_root,
      source_epoch, source_root, target_epoch, target_root
    )) AS nonbit_variants
  FROM default.libp2p_gossipsub_aggregate_and_proof FINAL
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-07-17 12:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-17 13:00:00')
  GROUP BY message_id
);
```

That returned:

- 247,296 message IDs from 8,122,792 observations
- 293,165 distinct `(message_id, aggregation_bits)` pairs
- 41,441 IDs with two or three bit strings
- zero IDs with another parsed semantic disagreement

The exact overlap made the shape obvious. There were **26,969 message IDs seen by Tysm, the Lighthouse sidecar and the Teku sidecar** during the hour. Not one had the same raw bit string across all three paths.

For every one of those IDs, right-padding the Tysm value with zero bytes reproduced the Lighthouse value. Teku shared the Lighthouse prefix but added one set bit in the final byte. The XOR mask was always `0x40` or `0x80`, and it was always a single bit that Teku added rather than removed.

```sql
SELECT
  count() AS messages_seen_by_all_three,
  countIf(t_bits = l_bits AND l_bits = k_bits) AS exact_three_way_matches,
  countIf(
    concat(t_bits, repeat('0', length(l_bits) - length(t_bits))) = l_bits
  ) AS tysm_zero_pad_matches_lighthouse,
  countIf(
    substring(l_bits, 1, length(l_bits) - 2)
      = substring(k_bits, 1, length(k_bits) - 2)
    AND bitAnd(l_last, k_last) = l_last
    AND bitAnd(
      bitXor(l_last, k_last),
      bitXor(l_last, k_last) - 1
    ) = 0
  ) AS teku_adds_one_delimiter_bit
FROM (
  SELECT *,
    reinterpretAsUInt8(unhex(right(l_bits, 2))) AS l_last,
    reinterpretAsUInt8(unhex(right(k_bits, 2))) AS k_last
  FROM (
    SELECT
      message_id,
      anyIf(aggregation_bits,
        meta_client_implementation = 'tysm') AS t_bits,
      anyIf(aggregation_bits,
        meta_client_implementation = 'Xatu Sidecar (lighthouse)') AS l_bits,
      anyIf(aggregation_bits,
        meta_client_implementation = 'Xatu Sidecar (teku)') AS k_bits,
      uniqExactIf(aggregation_bits,
        meta_client_implementation = 'tysm') AS t_count,
      uniqExactIf(aggregation_bits,
        meta_client_implementation = 'Xatu Sidecar (lighthouse)') AS l_count,
      uniqExactIf(aggregation_bits,
        meta_client_implementation = 'Xatu Sidecar (teku)') AS k_count
    FROM default.libp2p_gossipsub_aggregate_and_proof FINAL
    WHERE meta_network_name = 'mainnet'
      AND slot_start_date_time >= toDateTime('2026-07-17 12:00:00')
      AND slot_start_date_time <  toDateTime('2026-07-17 13:00:00')
    GROUP BY message_id
    HAVING t_count = 1 AND l_count = 1 AND k_count = 1
  )
);
```

The four output values were **26,969, 0, 26,969 and 26,969**. A naive popcount told the same story from another angle: Tysm and Lighthouse agreed on the participant count for every one of those 26,969 IDs, while Teku was exactly one higher every time. The median was 427 participant bits versus a naive Teku count of 428.

## The raw bytes pick a side

Message ID `4aee8c08a36f6a290f9a5b042057ea957e14568f` is the cleanest tiny example. The three stored strings were:

- Tysm: `0x000000000040`
- Lighthouse sidecar: the same six bytes followed by 48 zero bytes
- Teku sidecar: the same six bytes, 47 zero bytes, then `80`

Xatu's [raw Gossipsub payload archive](https://github.com/ethpandaops/xatu/releases/tag/v1.22.0) held two observations for that ID. Both were the same 451-byte Snappy payload with SHA-256 `396d220d1856e271d2fa5d2f02b94adeb8371726b03a237f02b4e2c4b72e637e`.

```sql
SELECT
  message_id,
  count() AS rows,
  uniqExact(message_data) AS payload_variants,
  groupUniqArray(message_size) AS sizes,
  groupUniqArray(hex(SHA256(message_data))) AS payload_sha256
FROM default.libp2p_gossipsub_message_payload FINAL
WHERE meta_network_name = 'mainnet'
  AND wallclock_slot_start_date_time >= toDateTime('2026-07-17 12:00:00')
  AND wallclock_slot_start_date_time <  toDateTime('2026-07-17 12:01:00')
  AND message_id = '4aee8c08a36f6a290f9a5b042057ea957e14568f'
GROUP BY message_id;
```

Decompressing it produced one 498-byte SSZ body. At byte offset 444, that body contained the 54-byte Teku form exactly, including the final `80`. That last bit is not another participant. It is the SSZ bitlist delimiter.

The [SSZ specification](https://github.com/ethereum/consensus-specs/blob/8c12caee279d77b322446d33440b37479117dcde/ssz/simple-serialize.md#bitlistn-progressivebitlist) says a bitlist appends one `1` bit at its logical length so a decoder can recover the length in bits. It belongs in serialized SSZ. It does not belong in a participant popcount.

## The code explains the split

This is not three clients disagreeing about an attestation. It is three instrumentation paths asking for three different representations of the same bitlist.

The Tysm path formats [`GetAggregationBits().Bytes()`](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/clmimicry/gossipsub_aggregate_and_proof.go#L144-L165). In the rows, that form drops trailing zero bytes. The Lighthouse sidecar formats [`aggregation_bits.as_slice()`](https://github.com/ethpandaops/dimhouse/blob/807fccbfa148f7fb7a6202a1ee38ef1c0422702e/overlay/xatu/src/observer_ffi.rs#L452-L482), which keeps the logical byte width but not the SSZ delimiter. The Teku plugin calls [`sszSerialize()`](https://github.com/ethpandaops/temu/blob/1a29f4a139247147b80eae6260b505b5b7f375b3/plugins/xatu/src/main/java/tech/pegasys/teku/plugin/xatu/XatuSidecarCore.java#L241-L261), which keeps the delimiter because that is what SSZ serialization does.

Each string comes from an understandable API choice. Putting them in one untyped `String` column makes them look comparable when they are not.

The safe path is to normalize at ingestion or decode the raw SSZ into one logical participant bitset. Until then, do not dedupe aggregates by the raw string, do not compare its byte length across emitter implementations, and do not popcount the Teku form without removing the delimiter. If the logical committee width is not available, trimming and padding by guesswork is not a substitute for decoding.

The aggregate was the same. The string was emitter-shaped telemetry.
