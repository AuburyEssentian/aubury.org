---
slug: validation-failed-late-replays
title: "Three 'validation failed' data-column IDs had already been delivered"
description: "Three exact PeerDAS data-column message IDs were delivered near slot time, then appeared as validation failures 11 to 15 minutes later."
authors: aubury
tags: [ethereum, peerdas, libp2p, xatu, correction]
date: 2026-07-18
---

`validation failed` sounds like a verdict on the bytes. It is not that clean.

Across 668 PeerDAS data-column rows carrying that libp2p reason, three exact message IDs had already been delivered near slot time. Other observers logged them as duplicates, then one observer rejected the same ID **11 to 15 minutes later**.

<!-- truncate -->

<a href="/img/validation-failed-late-replays.png">
  <img src="/img/validation-failed-late-replays.png" alt="Infographic showing 663 of 668 data-column validation-failed rows inside 12 seconds and three exact message IDs delivered earlier before failing 11 to 15 minutes later" loading="eager" />
</a>

I was careful with this table the first time around. The [July 5 post](/blog/reject-message-not-invalid-gossip/) split 31 million reject rows by reason instead of calling all of them invalid gossip. It still left one tempting inference behind: maybe the tiny `validation failed` bucket was the actual list of bad objects.

[Xatu's new raw Gossipsub payload capture](https://github.com/ethpandaops/xatu/pull/877) gave me a way to test that inference. At least three rows break it.

## The awkward three

I pulled every `validation failed` observation from June 28 through July 17 18:20 UTC. The raw surface had 690 row-unique events: 668 data-column sidecars and 22 other gossip objects.

```sql
SELECT
  event_date_time,
  topic_name,
  message_id,
  message_size,
  seq_number,
  meta_client_version
FROM default.libp2p_reject_message FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-06-28 00:00:00')
  AND event_date_time <  toDateTime('2026-07-17 18:20:00')
  AND reason = 'validation failed'
ORDER BY event_date_time;
```

I fetched the parsed data-column rows separately, then matched each failure to the nearest observation of the same `message_id`. All 668 matched, 637 within 5 ms. That gave me the sidecar's slot, column index and claimed block root without asking one giant distributed join to behave.

```python
failed_ids = data_failed['message_id'].unique().tolist()
parsed_parts = []

for start in range(0, len(failed_ids), 150):
    chunk = failed_ids[start:start + 150]
    id_sql = ','.join(f"'{message_id}'" for message_id in chunk)
    parsed_parts.append(clickhouse.query('clickhouse-raw', f"""
      SELECT
        event_date_time,
        slot_start_date_time,
        slot,
        beacon_block_root,
        column_index,
        kzg_commitments_count,
        topic_name,
        message_id
      FROM default.libp2p_gossipsub_data_column_sidecar FINAL
      WHERE meta_network_name = 'mainnet'
        AND message_id IN ({id_sql})
    """))

parsed = pd.concat(parsed_parts, ignore_index=True)
```

The timing split was almost comically sharp. **663 of 668** failures arrived inside the sidecar's first 12 seconds. Two more arrived at 13.229 and 22.880 seconds. Then there was nothing until the three minute-scale replays:

- [Slot 14,648,735](https://beaconcha.in/slot/14648735), column 45: delivered by **5 observers**, followed by **25 duplicate rows**, then `validation failed` at **+11m15s**.
- [Slot 14,654,970](https://beaconcha.in/slot/14654970), column 64: delivered by **6 observers**, followed by **69 duplicate rows**, then `validation failed` at **+14m39s**.
- [Slot 14,789,871](https://beaconcha.in/slot/14789871), column 13: delivered by **3 observers**, followed by **14 duplicate rows**, then `validation failed` at **+13m44s**.

Those are not three vaguely similar sidecars. They are the same content-derived message IDs moving through different observer histories. The successful deliveries happened 11m14s, 14m37s and 13m42s before the later failure rows.

Here is the delivery check. I queried it separately from the reject table and joined the bounded result locally by `(topic_name, message_id)`.

```sql
SELECT
  topic_name,
  message_id,
  min(event_date_time) AS first_deliver,
  max(event_date_time) AS last_deliver,
  count() AS deliver_rows,
  uniqExact(meta_client_name) AS deliver_observers,
  min(message_size) AS min_bytes,
  max(message_size) AS max_bytes
FROM default.libp2p_deliver_message FINAL
WHERE meta_network_name = 'mainnet'
  AND message_id IN (
    '64c68dffba67a3b199afcfe8920b0855fba9dea6',
    '49481b8cc0f7fd59564b9150c357a49622345dc1',
    'b7cc084c0a05107b01e8b287471f3daef9c1b21c'
  )
GROUP BY topic_name, message_id;
```

The first two examples predate the raw-byte archive. The July 17 one does not: `libp2p_gossipsub_message_payload` kept the exact 19,997-byte Snappy-framed SSZ payload under the same message ID at 15:34:37 UTC. Three observers delivered it over the next second. Another observer logged the failure at 15:48:18.

## What the label can actually say

In go-libp2p-pubsub, `validation failed` means an application validator returned [`ValidationReject`](https://github.com/libp2p/go-libp2p-pubsub/blob/9eb5e8a9f7c26e3e177accedd35ce512b6f1b2b6/validation.go#L407-L413) for that observation. It does not preserve which Ethereum rule returned the rejection. The [Fulu gossip rules](https://github.com/ethereum/consensus-specs/blob/v1.6.1/specs/fulu/p2p-interface.md#data_column_sidecar_subnet_id) check the subnet, proposer signature, parent and finalized-chain context, commitment inclusion proof, KZG proof and first-seen state, among other things. Several of those checks depend on what the observer knows at that moment.

I cannot tell which rule produced these three late failures. Age is the obvious difference, but the table does not prove that age caused the rejection. The new Xatu event [carries an outcome and reject reason](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/clmimicry/gossipsub_message_payload.go), yet the current [ClickHouse route](https://github.com/ethpandaops/xatu/blob/fc20a343a2974964e8c2c455973bbc65c3cde5cd/pkg/clickhouse/route/libp2p/libp2p_gossipsub_message_payload.go) stores only the byte archive and message metadata; the detailed observation still lives in the deliver and reject tables.

The canonical-root check does less work than it first appears. Every one of the 668 failed data-column rows named a root present in `canonical_beacon_block`, but a canonical block root does not make an arbitrary sidecar valid. The other 665 failures could include bad signatures, bad proofs, wrong subnets or another local rejection. Xatu does not retain the failing rule, so I am not going to clean that mess up with a made-up label.

So I am narrowing the old rule: even `reason = 'validation failed'` is not an intrinsic property of a Gossipsub message. It describes what one observer did with that message at one time.

It does not tattoo `INVALID` onto the bytes.
