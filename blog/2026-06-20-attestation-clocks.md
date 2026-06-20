---
slug: attestation-clocks
title: "Ethereum has an attestation wave at 4 seconds"
description: "On June 19, almost 30% of raw mainnet attestations were first seen after 4 seconds. Aggregate attestations landed at 8.04s with almost comic precision."
authors: aubury
tags: [ethereum, attestations, consensus, timing, data]
date: 2026-06-20
---

Attestations are not a smooth cloud of votes.

They pulse.

<!-- truncate -->

I started poking at `mainnet.fct_attestation_first_seen_by_validator` because it keeps two clocks for the same validator vote: when the raw attestation was first seen, and when that vote first appeared inside an aggregate.

The first thing that fell out was embarrassingly crisp.

On June 19, across **199,043,024 validator-vote rows** and **7,185 slots**, raw attestations had a median first-seen time of **2.916s** after slot start. Fine. That part is boring.

The ugly part is the tail: **29.92%** of raw votes were first seen after **4 seconds**.

Then the aggregate path showed up like a metronome. Aggregate first-seen p50 was **8.042s**. p95 was **8.072s**. And **97.84%** of aggregate observations landed between **8.000s and 8.099s**.

<img src="/img/attestation-clocks.png" alt="Raw Ethereum attestations form waves around 2.25s and 4.25s, while aggregate attestations spike around 8.04s" loading="eager" />

That chart uses two tables. The raw shape comes from the lighter 50ms chunk table, because counting per-validator rows for two weeks is rude to the database:

```sql
SELECT
  chunk_slot_start_diff AS bin_ms,
  sum(attestation_count) AS votes
FROM mainnet.fct_attestation_first_seen_chunked_50ms FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-19 00:00:00')
  AND slot_start_date_time < toDateTime('2026-06-20 00:00:00')
  AND chunk_slot_start_diff BETWEEN 0 AND 9000
GROUP BY bin_ms
ORDER BY bin_ms;
```

The aggregate numbers come from the per-validator table:

```sql
SELECT
  uniqExact(slot) AS slots,
  count() AS rows,
  round(quantileExact(0.5)(raw_seen_slot_start_diff) / 1000, 3) AS raw_p50_s,
  round(quantileExact(0.95)(raw_seen_slot_start_diff) / 1000, 3) AS raw_p95_s,
  round(100 * countIf(raw_seen_slot_start_diff > 4000) / count(), 2) AS raw_after_4s_pct,
  round(quantileExact(0.5)(agg_seen_slot_start_diff) / 1000, 3) AS agg_p50_s,
  round(quantileExact(0.95)(agg_seen_slot_start_diff) / 1000, 3) AS agg_p95_s,
  round(
    100 * countIf(agg_seen_slot_start_diff BETWEEN 8000 AND 8099)
    / countIf(agg_seen_slot_start_diff IS NOT NULL),
    2
  ) AS agg_8000_8099_pct,
  round(100 * countIf(agg_seen_slot_start_diff IS NULL) / count(), 2) AS agg_missing_pct
FROM mainnet.fct_attestation_first_seen_by_validator FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-19 00:00:00')
  AND slot_start_date_time < toDateTime('2026-06-20 00:00:00');
```

The result:

| Metric | Value |
| --- | ---: |
| Slots | 7,185 |
| Validator-vote rows | 199,043,024 |
| Raw first-seen p50 | **2.916s** |
| Raw first-seen p95 | **4.971s** |
| Raw first seen after 4s | **29.92%** |
| Aggregate first-seen p50 | **8.042s** |
| Aggregate first-seen p95 | **8.072s** |
| Aggregates in 8.000-8.099s | **97.84%** |
| Votes missing an aggregate observation | **0.24%** |

The spec explains why the two vertical lines are where they are. Mainnet slots are **12,000ms**. `ATTESTATION_DUE_BPS` is **3333**, so the attestation due point is basically 4 seconds. `AGGREGATE_DUE_BPS` is **6667**, so the aggregate due point is basically 8 seconds.

The part I did not expect was how visible those constants are in the data. Not vaguely. Not as a soft shoulder. A proper second wave.

The 4s tail also is not just one ingestion path being weird. Splitting the raw source on June 19 gives the same shape twice:

| Raw source | Share of rows | p50 | p95 | First seen after 4s |
| --- | ---: | ---: | ---: | ---: |
| `beacon_api_eth_v1_events_attestation` | 52.09% | 2.990s | 5.020s | **31.22%** |
| `libp2p_gossipsub_beacon_attestation` | 47.91% | 2.838s | 4.878s | **28.50%** |

I also checked the raw tables directly for one hour, without the refined first-seen table in the middle. Both `libp2p_gossipsub_beacon_attestation` and `beacon_api_eth_v1_events_attestation` had their late local maximum around **4.20s-4.35s**. Good enough. Same scar, different tables.

There is an easy mistake here: a vote first seen after 4s does not prove the validator signed after 4s. First-seen time includes gossip delay, observer location, client behavior, and whatever else happened between signing and measurement.

So the claim is narrower.

A large chunk of the network's raw attestation observations become visible to this measurement path after the nominal 4s attestation point. And the aggregate path is not a fuzzy backup. It is an 8-second clock.

That matters if you are using aggregates to reason about head-vote timing. By 8 seconds, the slot is already old. Aggregates are great for compact inclusion in the next block. They are not the fast path for understanding what validators knew when the head vote was forming.

Raw gossip is where the timing fight lives.

Aggregates are the receipt.

The daily check is what made me comfortable publishing this instead of treating it as a Friday data burp:

```sql
SELECT
  toDate(slot_start_date_time) AS day,
  uniqExact(slot) AS slots,
  sum(attestation_count) AS att_count,
  round(
    quantileExactWeighted(0.5)(chunk_slot_start_diff, attestation_count) / 1000,
    3
  ) AS raw_p50_s,
  round(
    quantileExactWeighted(0.95)(chunk_slot_start_diff, attestation_count) / 1000,
    3
  ) AS raw_p95_s,
  round(
    100 * sumIf(attestation_count, chunk_slot_start_diff > 4000)
    / sum(attestation_count),
    2
  ) AS raw_after_4s_pct
FROM mainnet.fct_attestation_first_seen_chunked_50ms FINAL
WHERE slot_start_date_time >= toDate('2026-06-06')
  AND slot_start_date_time < toDate('2026-06-20')
GROUP BY day
ORDER BY day;
```

Every full day from June 6 through June 19 had raw p95 at **4.95s** and a post-4s share sitting around **29-30%**.

That is the little machine inside every slot: one wave around 2.25 seconds, another around 4.25 seconds, then the aggregate hammer at 8.04.

Ethereum is a 12-second protocol, but the interesting parts are hiding in the sub-second ticks.
