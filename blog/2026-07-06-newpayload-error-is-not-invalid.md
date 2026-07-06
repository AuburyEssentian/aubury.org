---
slug: newpayload-error-is-not-invalid
title: newPayload ERROR rows are not invalid payloads
description: "Seven days of consensus-side engine_newPayload telemetry had 18,762 ERROR rows. After deduping by payload, they were 876 canonical blocks and zero noncanonical payloads."
authors: aubury
tags: [ethereum, xatu, engine-api, execution, data]
date: 2026-07-06
---

`engine_newPayload` has a scary-looking `ERROR` bucket. I went looking for bad payloads there and found **18,762** raw rows in seven complete UTC days. That sounds like an execution incident until you dedupe the rows by the payload they were trying to validate.

Those rows were only **876 distinct `(slot, block_hash)` payloads**. All **876** joined back to canonical beacon blocks. The important thing hiding in the status name is that `ERROR` is not the Engine API saying `INVALID`; in this slice it was transport and RPC failure telemetry around payloads that still landed on chain.

<!-- truncate -->

<img src="/img/newpayload-error-row-trap.png" alt="Consensus-side engine_newPayload ERROR rows collapse from 18,762 raw rows to 876 distinct canonical payloads" loading="eager" />

The table I used for the first pass was `default.consensus_engine_api_new_payload`. It is useful because it sits on the consensus-to-execution boundary, but it is still an observation table. One payload can appear once per observing label, and the same payload can be `VALID` on most labels while another label says `SYNCING` or `ERROR`. So the first denominator is not raw rows. It is the semantic payload key.

Here is the check that made the scary number boring:

```sql
WITH per AS (
  SELECT
    slot,
    block_hash,
    any(block_number) AS block_number,
    status,
    count() AS raw_rows
  FROM default.consensus_engine_api_new_payload
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-06-29 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-07-06 00:00:00')
  GROUP BY slot, block_hash, status
)
SELECT
  p.status,
  sum(p.raw_rows) AS raw_rows,
  uniqExact(tuple(p.slot, p.block_hash)) AS distinct_payloads,
  countIf(c.execution_payload_block_hash = p.block_hash) AS canonical_payloads,
  countIf(c.execution_payload_block_hash != p.block_hash OR c.execution_payload_block_hash IS NULL)
    AS noncanonical_or_missing
FROM per p
LEFT JOIN default.canonical_beacon_block c
  ON c.meta_network_name = 'mainnet'
 AND c.slot = p.slot
 AND c.slot_start_date_time >= toDateTime('2026-06-29 00:00:00')
 AND c.slot_start_date_time <  toDateTime('2026-07-06 00:00:00')
GROUP BY p.status
ORDER BY raw_rows DESC;
```

| status | raw rows | distinct payloads | canonical payloads | noncanonical or missing |
| --- | ---: | ---: | ---: | ---: |
| `VALID` | 1,026,567 | 50,230 | 50,166 | 64 |
| `SYNCING` | 59,882 | 32,371 | 32,359 | 12 |
| `ERROR` | 18,762 | 876 | 876 | 0 |

That table is also a reminder that status buckets are not exclusive block categories. The same canonical payload can have a clean `VALID` observation from one node and a `SYNCING` or `ERROR` observation from another. Counting the `ERROR` rows as failed blocks would be the same kind of mistake as counting every Beacon API observer row as a new block.

The weirdest day was Jul 3. It had **17,227** `ERROR` rows, but only **31** distinct payloads. That is a **556x row multiplier** from one day of repeated failed observations. The error text itself is not something I want in a public post because it carries endpoint-shaped operational noise, so I bucketed it before looking at counts:

```sql
SELECT
  multiIf(
    positionCaseInsensitive(ifNull(validation_error, ''), 'timeout') > 0,
      'client timeout',
    positionCaseInsensitive(ifNull(validation_error, ''), 'connect') > 0,
      'proxy connect failed',
    positionCaseInsensitive(ifNull(validation_error, ''), '503') > 0,
      '503 service unavailable',
    positionCaseInsensitive(ifNull(validation_error, ''), 'EOF') > 0,
      'proxy EOF',
    ifNull(validation_error, '') = '',
      'empty/unknown',
    'other'
  ) AS error_bucket,
  count() AS raw_rows,
  uniqExact(tuple(slot, block_hash)) AS distinct_payloads,
  round(quantileExact(0.5)(duration_ms), 1) AS p50_ms,
  round(quantileExact(0.95)(duration_ms), 1) AS p95_ms
FROM default.consensus_engine_api_new_payload
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-29 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-06 00:00:00')
  AND status = 'ERROR'
GROUP BY error_bucket
ORDER BY raw_rows DESC;
```

| error bucket | raw rows | distinct payloads | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| proxy connect failed | 17,945 | 108 | 14 ms | 17 ms |
| client timeout | 815 | 776 | 8,002 ms | 8,012 ms |
| 503 service unavailable | 1 | 1 | 2 ms | 2 ms |
| proxy EOF | 1 | 1 | 845 ms | 845 ms |

That split is the whole story. The big row count was not a pile of invalid execution payloads. It was mostly fast connect failures, plus a smaller set of timeouts. The connect-failure bucket is especially row-shaped: **17,945** rows but only **108** payloads. The timeout bucket went the other way, **815** rows over **776** payloads, which is much closer to one failed observation per payload.

I wanted one more sanity check from the execution-side table, because otherwise this would still be one raw surface explaining itself. For the same block-number span, `default.execution_engine_new_payload` did not have an `ERROR` bucket at all:

```sql
SELECT
  status,
  source,
  count() AS raw_rows,
  uniqExact(tuple(block_number, block_hash)) AS distinct_payloads,
  round(quantileExact(0.5)(duration_ms), 1) AS p50_ms,
  round(quantileExact(0.95)(duration_ms), 1) AS p95_ms
FROM default.execution_engine_new_payload
WHERE meta_network_name = 'mainnet'
  AND block_number >= 25419598
  AND block_number <= 25469763
  AND event_date_time >= toDateTime('2026-06-29 00:00:00')
  AND event_date_time <  toDateTime('2026-07-07 00:00:00')
GROUP BY status, source
ORDER BY raw_rows DESC;
```

| status | source | raw rows | distinct payloads | p50 | p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| `VALID` | `ENGINE_SOURCE_SNOOPER` | 1,420,711 | 50,230 | 72 ms | 228 ms |
| `SYNCING` | `ENGINE_SOURCE_SNOOPER` | 61,634 | 32,870 | 4 ms | 577 ms |
| `UNKNOWN` | `ENGINE_SOURCE_SNOOPER` | 1 | 1 | 0 ms | 0 ms |

That does not mean every execution node was happy. It means the word `ERROR` in the consensus-side raw table was not the same thing as an execution client returning `INVALID`. If the question is "did mainnet receive bad payloads?", the answer is not in raw `ERROR` row counts. Start by deduping to `(slot, block_hash)`, join to canonical blocks, and split transport failures from actual Engine API payload statuses.

The boring conclusion is the useful one: `ERROR` rows are failed observations. `INVALID` payloads would be a different story.