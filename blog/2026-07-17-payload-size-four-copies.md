---
slug: payload-size-four-copies
title: "One payload became four copies in beacon API data"
description: "A two-hour beacon API sample contained 213,035 transaction entries for 51,254 canonical transactions on one observer path. The other eight observers stayed at one copy."
authors: aubury
tags: [ethereum, beacon-api, execution-payload, data-quality]
date: 2026-07-17
---

One `beacon_api_eth_v3_validator_block` observer made Ethereum payloads look four times larger than they were.

In a two-hour mainnet sample, 161 prepared blocks from that path matched the canonical execution payload for their slot. The prepared-block rows reported **213,035 transaction entries**. The matching canonical blocks contained **51,254 transactions**: a **4.156x multiplier**.

<!-- truncate -->

This was not a busy-block effect. Of those 161 matches, **141 were exactly 4x**. The only observed count ratios were 1.000x, 3.990x, 4.000x and 5.000x, which is a deeply weird shape for anything driven by normal transaction demand.

The table stores a prepared block returned by `/eth/v3/validator/blocks/{slot}`. That is local proposer telemetry, not a copy of the canonical block table. I pulled both sides separately for July 17 from 08:00 to 10:00 UTC, then joined them locally by slot. The execution block number, base fee, gas limit, gas used, blob gas used and excess blob gas had to agree before I called a row a canonical match.

```sql
-- Prepared-block responses. Fetch this from clickhouse-raw.
SELECT
  slot,
  event_date_time,
  meta_client_name,
  meta_consensus_implementation,
  execution_payload_block_number,
  execution_payload_base_fee_per_gas,
  execution_payload_gas_limit,
  execution_payload_gas_used,
  execution_payload_blob_gas_used,
  execution_payload_excess_blob_gas,
  execution_payload_transactions_count,
  execution_payload_transactions_total_bytes,
  block_total_bytes
FROM default.beacon_api_eth_v3_validator_block FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-17 08:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-17 10:00:00')
  AND execution_payload_transactions_count IS NOT NULL;
```

```sql
-- Canonical side. Fetch separately, then join locally by slot.
SELECT
  slot,
  block_root,
  execution_payload_block_number,
  execution_payload_base_fee_per_gas,
  execution_payload_gas_limit,
  execution_payload_gas_used,
  execution_payload_blob_gas_used,
  execution_payload_excess_blob_gas,
  execution_payload_transactions_count,
  execution_payload_transactions_total_bytes,
  block_total_bytes
FROM default.canonical_beacon_block FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-07-17 08:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-17 10:00:00');
```

I kept the raw distributed tables out of one large join. After the local match, the affected path had **214 prepared-block responses**, including the 161 canonical matches. Decoding the transaction lists produced **286,856 entries**. Deduplicating identical byte strings inside each payload left one-copy transaction data of **169.310 MB**, versus **672.092 MB** stored across the repeated lists.

<a href="/img/payload-size-four-copies.png?v=20260717-1"><img src="/img/payload-size-four-copies.png?v=20260717-1" alt="Two comparisons showing 213,035 prepared-block transaction entries versus 51,254 canonical transactions, and 672.1 MB of stored transaction bytes versus 169.3 MB after within-payload deduplication" loading="eager" /></a>

The byte check matters. A bad transaction counter could create a clean integer ratio without changing the payload itself. That is not what happened here: every duplicate transaction hash inside a prepared response carried the same byte string, and no hash had two byte variants. The extra entries were redundant copies, not four different transactions hiding behind one hash.

The control cohort was boring in exactly the right way. The other eight V3 observers produced **6,912 canonical-matched payloads**, and all 6,912 had a 1.000x prepared-to-canonical transaction-count ratio. The anomaly was concentrated in one Nimbus-attached observation path rather than spread across the endpoint or the canonical table.

The 53 prepared blocks that did not match the canonical payload showed the same repeated-list shapes. I did not throw them into the canonical denominator, because a locally prepared block can legitimately differ from the block that wins the slot. They are still useful as a control against the idea that canonicalization created the copies.

There is another check hiding in the block-size field. For the 161 canonical matches, `block_total_bytes` sat a median **0.176 MB** above the deduplicated execution transaction bytes and never more than **0.408 MB** above them. That looks like one execution payload plus the rest of the beacon block. It does not look like four full transaction lists, so the inflated transaction aggregate and the encoded block-size field disagree about what "payload size" means on this path.

I cannot tell where the copying happened. The ClickHouse row does not retain enough source-path detail to separate the consensus client, its execution client, Xatu's event decoration, or the insertion pipeline. The safe finding is narrower: one observer path emitted repeated transaction entries, while eight peers did not.

It is also not a bandwidth result. `execution_payload_transactions_total_bytes` sums bytes in the decoded container; it does not measure packets on the wire. But any query that sums that field as unique payload data would overstate this sample by roughly four times. Until the capture path is explained, the cheap guard is to compare prepared counts with canonical counts and refuse integer-ish multipliers that only one observer can see.
