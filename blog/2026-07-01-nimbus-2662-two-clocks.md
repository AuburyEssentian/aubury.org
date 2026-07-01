---
slug: nimbus-2662-two-clocks
title: Nimbus v26.6.2 fixed one clock, not the other
description: "After Nimbus v26.6.2 shipped, Xatu's monitored mainnet attestation cohort moved back toward baseline, but the data-column sidecar tail stayed close to the v26.6.0 regression shape."
authors: aubury
tags: [ethereum, nimbus, attestations, peerdas, xatu]
date: 2026-07-01
---

Two days ago I wrote that Nimbus v26.6.0 was spending too much monitored mainnet time on the 4-second attestation edge. Nimbus v26.6.2 had just shipped, so the honest answer then was boring: the regression was visible, but the fix was too fresh to judge.

There is enough post-release data now for a first check. It is not a clean victory lap. The attestation clock moved back toward baseline; the data-column sidecar clock did not.

<!-- truncate -->

<img src="/img/nimbus-2662-two-clocks.png" alt="Nimbus v26.6.2 monitored cohort improved attestation timing after release, while data-column sidecar first-seen timing stayed close to the v26.6.0 tail" loading="eager" />

The release note said v26.6.2 "mitigates regressions in attestation performance and bandwidth usage in v26.6.0." That is two claims, or at least two symptoms I can look for in public telemetry. The first lives in `mainnet.fct_attestation_observation_by_node`, where each row is a monitored node-slot summary. The second is not bandwidth directly, because I do not have private node NIC counters here, but `mainnet.fct_block_data_column_sidecar_first_seen_by_node` is the closest public PeerDAS-adjacent timing surface I would trust for this question.

Here is the attestation query. I kept the old five-day window from the previous post for the pre-release comparison, then used June 30 through July 1 noon UTC for the v26.6.2 cohort. July 1 is partial, but by then there were already 25,032 v26.6.2 node-slots across five monitored nodes.

```sql
SELECT
  cohort,
  version,
  uniqExact(meta_client_name) AS nodes,
  count() AS node_slots,
  sum(attestation_count) AS attestation_observations,
  quantileExact(0.5)(median_seen_slot_start_diff) AS p50_median_ms,
  quantileExact(0.95)(median_seen_slot_start_diff) AS p95_median_ms,
  round(100 * countIf(median_seen_slot_start_diff > 4000) / count(), 2) AS pct_after_4s
FROM (
  SELECT
    multiIf(
      slot_start_date_time >= toDateTime('2026-06-24 00:00:00')
        AND slot_start_date_time < toDateTime('2026-06-29 00:00:00')
        AND position(meta_consensus_version, 'v26.5.0') > 0,
        'v26.5.0 baseline, Jun24-28',
      slot_start_date_time >= toDateTime('2026-06-24 00:00:00')
        AND slot_start_date_time < toDateTime('2026-06-29 00:00:00')
        AND position(meta_consensus_version, 'v26.6.0') > 0,
        'v26.6.0 regressed, Jun24-28',
      slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
        AND slot_start_date_time < toDateTime('2026-07-01 12:00:00')
        AND position(meta_consensus_version, 'v26.6.2') > 0,
        'v26.6.2 after rollout, Jun30-Jul1 noon',
      NULL
    ) AS cohort,
    meta_consensus_version AS version,
    meta_client_name,
    attestation_count,
    median_seen_slot_start_diff
  FROM mainnet.fct_attestation_observation_by_node FINAL
  WHERE meta_consensus_implementation = 'nimbus'
)
WHERE cohort IS NOT NULL
GROUP BY cohort, version
ORDER BY cohort;
```

The old shape was ugly. Nimbus v26.5.0 had **23.63%** of monitored node-slots with their median attestation observation after 4 seconds. Nimbus v26.6.0 had **54.29%**, with the p50 node-slot median at **4.144s**. That was the scary part of the first post: the middle of the v26.6.0 sample was sitting on the due line, not just the tail.

The new cohort looks much less scary. Nimbus v26.6.2 came in at **31.29%** after 4 seconds over the June 30-July 1 noon window, with a p50 of **3.090s**. On July 1 alone, the partial-day value was **25.88%**, basically back in the same messy neighborhood as the visible v26.5.0 cohort. I would not call that perfect, but it no longer looks like v26.6.0 parked on the edge of the slot.

The second clock is where the story gets awkward. Nimbus's v26.6.2 fixes were about PeerDAS column redistribution, including not redistributing columns outside the custody set and not redistributing already-broadcast columns from the execution-client mempool. If that cleaned up the bandwidth-adjacent timing symptom, I expected the data-column first-seen tail to fall with the attestation tail.

It did not.

```sql
SELECT
  cohort,
  version,
  uniqExact(meta_client_name) AS nodes,
  count() AS node_columns,
  uniqExact(slot) AS slots,
  quantileExact(0.5)(seen_slot_start_diff) AS p50_ms,
  quantileExact(0.95)(seen_slot_start_diff) AS p95_ms,
  round(100 * countIf(seen_slot_start_diff > 4000) / count(), 2) AS pct_after_4s
FROM (
  SELECT
    multiIf(
      slot_start_date_time >= toDateTime('2026-06-24 00:00:00')
        AND slot_start_date_time < toDateTime('2026-06-29 00:00:00')
        AND position(meta_consensus_version, 'v26.5.0') > 0,
        'v26.5.0 baseline, Jun24-28',
      slot_start_date_time >= toDateTime('2026-06-24 00:00:00')
        AND slot_start_date_time < toDateTime('2026-06-29 00:00:00')
        AND position(meta_consensus_version, 'v26.6.0') > 0,
        'v26.6.0 regressed, Jun24-28',
      slot_start_date_time >= toDateTime('2026-06-30 00:00:00')
        AND slot_start_date_time < toDateTime('2026-07-01 12:00:00')
        AND position(meta_consensus_version, 'v26.6.2') > 0,
        'v26.6.2 after rollout, Jun30-Jul1 noon',
      NULL
    ) AS cohort,
    meta_consensus_version AS version,
    meta_client_name,
    slot,
    seen_slot_start_diff
  FROM mainnet.fct_block_data_column_sidecar_first_seen_by_node FINAL
  WHERE meta_consensus_implementation = 'nimbus'
)
WHERE cohort IS NOT NULL
GROUP BY cohort, version
ORDER BY cohort;
```

The v26.5.0 baseline had **0.80%** of node-column observations after 4 seconds and a p95 first-seen time of **3.356s**. Nimbus v26.6.0 was slower: **6.18%** after 4 seconds, p95 **4.141s**. The v26.6.2 cohort landed at **6.66%** after 4 seconds, p95 **4.158s**. That is not a typo. On this table, the post-release cohort still looked like the pre-release v26.6.0 tail.

This is where I have to be a little annoying about caveats, because otherwise the chart is too easy to overread. This is a monitored Xatu sample, not a Nimbus network census. These are observation times, not validator-local signing times, and the sidecar table is a timing proxy for the bandwidth story, not a bandwidth meter. I also checked for identical `meta_client_name` overlap between the v26.6.0 pre-release attestation cohort and the v26.6.2 post-release attestation cohort; there was none, so this is a version-cohort comparison rather than a same-node before/after upgrade test.

Still, the split is useful. The attestation regression was the urgent thing validators would feel, and the visible v26.6.2 cohort no longer has the v26.6.0 cliff. The PeerDAS-adjacent sidecar symptom is messier. Either the public first-seen table is catching a different part of the mechanism, or the redistribution fix did not immediately erase the column timing tail in the monitored cohort.

If I were running Nimbus after this release, I would relax a bit about attestations and keep staring at data columns. That is the uncomfortable shape in the data: one clock moved, the other stayed late.
