---
slug: nimbus-266-attestation-regression
title: Nimbus v26.6.0 spent the week on the 4-second edge
description: "Nimbus v26.6.2 says it mitigates v26.6.0 attestation and bandwidth regressions. Xatu's monitored mainnet sample showed why: v26.6.0 node-slots had median attestation observations after 4s 54% of the time."
authors: aubury
tags: [ethereum, nimbus, attestations, peerdas, xatu]
date: 2026-06-29
---

Nimbus cut [v26.6.2](https://github.com/status-im/nimbus-eth2/releases/tag/v26.6.2) this morning with a blunt note: it "mitigates regressions in attestation performance and bandwidth usage in v26.6.0." That is exactly the kind of release note that is easy to nod at and move past. I wanted to know whether the monitored mainnet data had a shape behind it.

It did.

<!-- truncate -->

<img src="/img/nimbus-266-attestation-regression.png" alt="Nimbus v26.6.0 monitored nodes had later attestation observations and a slower data-column sidecar tail than v26.5.0 over June 24-28 2026" loading="eager" />

The cleanest attestation surface was not the raw Beacon API eventstream. Raw eventstream rows can contain replay and catch-up tails, and I have already tripped over that enough times. For this one I used `mainnet.fct_attestation_observation_by_node`, which collapses the data to one row per monitored node per slot with an attestation count and timing summary.

Here is the query that produced the attestation side of the chart. The window is the five complete UTC days before the v26.6.2 release, so this is a look back at v26.6.0, not a claim about the fix.

```sql
SELECT
  if(
    position(meta_consensus_version, 'v26.6.0') > 0,
    'Nimbus v26.6.0',
    if(
      position(meta_consensus_version, 'v26.5.0') > 0,
      'Nimbus v26.5.0',
      'other Nimbus'
    )
  ) AS bucket,
  uniqExact(meta_client_name) AS nodes,
  count() AS node_slots,
  sum(attestation_count) AS attestation_observations,
  quantileExact(0.5)(median_seen_slot_start_diff) AS p50_node_slot_median_ms,
  quantileExact(0.95)(median_seen_slot_start_diff) AS p95_node_slot_median_ms,
  round(
    100 * countIf(median_seen_slot_start_diff > 4000) / count(),
    2
  ) AS pct_node_slots_median_after_4s
FROM mainnet.fct_attestation_observation_by_node FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-24 00:00:00')
  AND slot_start_date_time < toDateTime('2026-06-29 00:00:00')
  AND meta_consensus_implementation = 'nimbus'
GROUP BY bucket
ORDER BY bucket;
```

The immediate predecessor looked fine in this sample. Nimbus v26.5.0 had **151,309** node-slots across **8** monitored nodes, with a p50 node-slot median attestation observation at **2.909s**. Only **23.61%** of its node-slots had their median attestation observation after 4 seconds.

Nimbus v26.6.0 was a different shape. It had **91,875** node-slots across **8** monitored nodes, and its p50 node-slot median was **4.144s**. **54.27%** of v26.6.0 node-slots had their median attestation observation after 4 seconds. That is not a tiny tail moving around. That is the middle of the monitored v26.6.0 sample sitting on the attestation due line.

The 4-second line is not magic, but it is not arbitrary either. Mainnet's 12-second slot clock puts the nominal attestation due point at about 4 seconds. This table is still observation time, not local validator signing time, so I would not turn it into a missed-reward calculation from this query alone. It is enough to say the observed timing got uncomfortable.

The release note also said bandwidth, and the two fixes it listed were both about PeerDAS column redistribution: do not redistribute columns outside the custody set, and do not redistribute already-broadcast columns from the execution client mempool. I cannot see private node bandwidth from Panda, but the data-column sidecar first-seen tail moved in the same direction.

```sql
SELECT
  if(
    position(meta_consensus_version, 'v26.6.0') > 0,
    'Nimbus v26.6.0',
    if(
      position(meta_consensus_version, 'v26.5.0') > 0,
      'Nimbus v26.5.0',
      'other Nimbus'
    )
  ) AS bucket,
  uniqExact(meta_client_name) AS nodes,
  count() AS node_columns,
  quantileExact(0.5)(seen_slot_start_diff) AS p50_ms,
  quantileExact(0.95)(seen_slot_start_diff) AS p95_ms,
  round(100 * countIf(seen_slot_start_diff > 4000) / count(), 2) AS pct_columns_after_4s
FROM mainnet.fct_block_data_column_sidecar_first_seen_by_node FINAL
WHERE slot_start_date_time >= toDateTime('2026-06-24 00:00:00')
  AND slot_start_date_time < toDateTime('2026-06-29 00:00:00')
  AND meta_consensus_implementation = 'nimbus'
GROUP BY bucket
ORDER BY bucket;
```

That cross-check is less dramatic, which is good. If both tables screamed by the same amount I would worry that I was just measuring a broken observer. Nimbus v26.5.0 had data-column p95 at **3.356s**, with **0.80%** of node-column observations after 4 seconds. Nimbus v26.6.0 had p95 at **4.141s**, with **6.17%** after 4 seconds. Other Nimbus versions in the same window were lower still: p95 **3.182s**, **0.16%** after 4 seconds.

There are a few caveats I would keep taped to this chart. This is a monitored Xatu sample, not a network-wide Nimbus census. I am not naming or grouping individual nodes, and I am not claiming every Nimbus v26.6.0 validator on the network behaved this way. Older Nimbus versions in the sample were not all clean either, so the honest comparison here is narrower: v26.6.0 versus the still-visible v26.5.0 cohort and the data-column timing cross-check.

That narrower comparison is enough. The release note said v26.6.0 had attestation and bandwidth regressions. The monitored mainnet data says the regression was visible at the exact part of the slot where attestations stop being comfortable.
