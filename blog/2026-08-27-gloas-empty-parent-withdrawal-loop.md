---
slug: gloas-empty-parent-withdrawal-loop
title: "After one empty Gloas payload, the next missed 47× as often"
description: "On Platåberget, a payload was absent in 18.1% of blocks after an empty parent versus 0.38% after a delivered one. Exact Lighthouse logs expose a sticky withdrawal-root failure."
authors: [aubury]
tags: [ethereum, gloas, lighthouse, devnet, xatu]
date: 2026-08-27
---

Gloas is supposed to recover cleanly when an execution payload does not arrive. The beacon chain keeps moving, the pending withdrawals stay carried in state, and the next builder gets another shot.

On Platåberget, that recovery path sometimes dug the hole deeper. Over five complete UTC days, **23 of 127 payloads after an absent parent were also absent**. After a delivered parent, the same thing happened in 100 of 26,098 cases. That is 18.110% versus 0.383%, or **47.3× as often**.

Exact Lighthouse rejection logs identify a withdrawal-root mismatch in 16 of those 23 recurrences. The longest empty run lasted six consecutive slots.

<!-- truncate -->

## The parent is the denominator

A Gloas Payload Timeliness Committee (PTC) votes separately on whether the execution payload was present and whether its blob data was available. I treated a payload as present only with more than 256 payload-present votes, kept canonical roots, then joined each child to the exact beacon parent recorded in its payload bid. Using `slot - 1` here would be wrong because skipped physical slots can sit between a child and its actual parent.

This is the query that produced the two headline rates. The window is 2026-08-21 00:00 through 2026-08-26 00:00 UTC. It contained 28,550 canonical PTC decisions; 26,225 children had both a bid and a canonical parent decision inside the same bounded window.

```sql
WITH votes AS (
  SELECT
    slot,
    block_root,
    payload_present_votes,
    status
  FROM `glamsterdam-devnet-8`.fct_block_payload_ptc_vote FINAL
  WHERE slot_start_date_time >= toDateTime('2026-08-21 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-26 00:00:00')
), bids AS (
  SELECT block_root, parent_block_root
  FROM `glamsterdam-devnet-8`.fct_block_payload_bid FINAL
  WHERE slot_start_date_time >= toDateTime('2026-08-21 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-26 00:00:00')
), paired AS (
  SELECT
    c.block_root AS child_root,
    c.payload_present_votes AS child_present_votes,
    p.block_root AS parent_root,
    p.payload_present_votes AS parent_present_votes
  FROM votes AS c
  INNER JOIN bids AS b ON c.block_root = b.block_root
  INNER JOIN votes AS p ON b.parent_block_root = p.block_root
  WHERE c.status = 'canonical'
    AND p.status = 'canonical'
)
SELECT
  parent_present_votes > 256 AS parent_delivered,
  count() AS matched_children,
  countIf(child_present_votes <= 256) AS child_absent,
  uniqExact(child_root) AS unique_children,
  uniqExact(parent_root) AS unique_parents
FROM paired
GROUP BY parent_delivered
ORDER BY parent_delivered DESC
```

The result is easier to read as two lines than as a cramped mobile table:

- After a delivered parent: 100 absent payloads / 26,098 matched children = **0.383171%**
- After an absent parent: 23 absent payloads / 127 matched children = **18.110236%**

The second rate changes how this failure feels. A missing payload is rare after a healthy parent, but once the parent is empty, another miss becomes a fairly ordinary outcome.

![Two conditional payload-absence rates on a shared 0–20% scale, plus the six-slot empty run from slot 88110 through 88115 and recovery at 88116.](/img/gloas-empty-parent-withdrawal-loop.png)

## The withdrawal batch got stuck

The execution layer and consensus state are deliberately out of step after an empty Gloas parent. Consensus has already deducted the expected withdrawals, but the execution payload never applied them. The next payload must therefore reuse `state.payload_expected_withdrawals`, the carried batch, rather than calculate a fresh one from the advanced state.

Lighthouse's external-builder payload-attributes path calculated a fresh batch. If that fresh list differed from the carried list, the builder produced a payload with the wrong withdrawals root. The beacon node rejected the reveal, the carried withdrawals remained pending, and the same bad recovery path could run again after another empty parent. Lighthouse [PR #9894](https://github.com/sigp/lighthouse/pull/9894) fixed that branch in commit [`b14b9b4`](https://github.com/sigp/lighthouse/commit/b14b9b4564c96692b61cf02f43f05ac9e0b2c287). Consensus-specs [PR #5570](https://github.com/ethereum/consensus-specs/pull/5570) later added the non-empty carried-withdrawal case to a unit test.

The logs are unusually specific here. I reduced repeated `Execution payload envelope rejected` lines to one exact block root. Each semantic rejection appeared three times because the reveal was retried, so counting log lines would have tripled the incident.

```python
from ethpandaops import clickhouse

logs = clickhouse.query("clickhouse-raw", """
SELECT
  extract(Body, 'block_root: (0x[0-9a-f]{64})') AS rejected_root,
  min(Timestamp) AS first_rejection,
  max(Timestamp) AS last_rejection,
  count() AS rejection_log_rows
FROM external.otel_logs
WHERE Timestamp >= toDateTime64('2026-08-24 00:00:00', 9)
  AND Timestamp <  toDateTime64('2026-08-27 00:00:00', 9)
  AND ServiceName = 'beacon'
  AND ResourceAttributes['network'] = 'glamsterdam-devnet-8'
  AND positionCaseInsensitive(Body, 'Execution payload envelope rejected') > 0
  AND positionCaseInsensitive(Body, 'WithdrawalsRootMismatch') > 0
GROUP BY rejected_root
HAVING rejected_root != ''
ORDER BY first_rejection
""")

# The raw logs and refined PTC tables are on different clusters.
# Carry the bounded root set into the second, actually executed query.
roots_sql = ",".join(repr(str(root)) for root in logs.rejected_root)
outcomes = clickhouse.query("clickhouse-refined", f"""
SELECT
  slot,
  block_root,
  status,
  payload_present_votes,
  blob_data_available_votes,
  ptc_validators
FROM `glamsterdam-devnet-8`.fct_block_payload_ptc_vote FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-24 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-27 00:00:00')
  AND block_root IN ({roots_sql})
ORDER BY slot, block_root
""")
```

That produced **31 unique mismatch roots** between August 24 08:03 and August 26 11:41 UTC: 24 canonical and seven orphaned. All 31 had zero payload-present votes. Among the 24 canonical roots, **23 still had more than 256 blob-data-available votes**. This was a payload-reveal failure, not a broad case of the blobs disappearing with it.

I also rebuilt the vote totals from raw canonical payload attestations. For every canonical mismatch root, `count()` equalled the number of unique `(slot, containing block root, position)` rows, and both vote sums matched the refined model exactly.

```python
raw_ptc = clickhouse.query("clickhouse-raw", f"""
SELECT
  a.beacon_block_root AS attested_root,
  count() AS raw_rows,
  uniqExact((a.slot, a.block_root, a.position)) AS unique_positions,
  sumIf(a.attesting_validator_count, a.payload_present)
    AS raw_payload_present_votes,
  sumIf(a.attesting_validator_count, a.blob_data_available)
    AS raw_blob_available_votes
FROM `glamsterdam-devnet-8`.canonical_beacon_block_payload_attestation AS a FINAL
WHERE a.slot_start_date_time >= toDateTime('2026-08-24 00:00:00')
  AND a.slot_start_date_time <  toDateTime('2026-08-27 00:00:00')
  AND a.beacon_block_root IN ({roots_sql})
GROUP BY a.beacon_block_root
ORDER BY a.beacon_block_root
""")
```

The seven orphaned roots also had mismatch logs, but I kept them out of the headline. Their refined rows preserve a partial observed vote surface, while canonical rows use the on-chain aggregates. Mixing the two would make the clean conditional comparison worse, not better.

## Six slots in the hole

The longest canonical run covered slots 88110 through 88115. Payload-present votes were `[146, 0, 0, 0, 0, 0]`; exact withdrawal-root mismatch logs appeared on slots 88111 through 88114. Slot 88116 recovered with all 512 payload-present votes.

```sql
SELECT
  slot,
  block_root,
  payload_present_votes,
  blob_data_available_votes,
  ptc_validators
FROM `glamsterdam-devnet-8`.fct_block_payload_ptc_vote FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-21 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-26 00:00:00')
  AND status = 'canonical'
  AND slot BETWEEN 88110 AND 88116
ORDER BY slot
```

The 47.3× ratio is conditional telemetry, not a claim that this Lighthouse branch caused all 23 recurrences. The exact logs identify 16 of them; the other seven need different evidence. This is also pre-release devnet software, not a Mainnet incident or a client-performance table.

One more awkward boundary: PR #9894 merged on August 24, but mismatch logs continued afterward. The devnet image used a floating network tag, not a client commit digest, so the merge time is not a deployment time. I cannot tell from these public rows when the fixed binary actually replaced the old one.

The happy path wasn't the problem. Recovery was. One missing payload changed which withdrawal list the next payload had to carry, and the wrong branch could keep the chain in the hole.
