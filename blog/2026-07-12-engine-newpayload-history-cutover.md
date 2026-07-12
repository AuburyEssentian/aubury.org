---
slug: engine-newpayload-history-cutover
title: "The newPayload backfill changes the runners on March 27"
description: "xatu-cbt's longer engine_newPayload history crosses a source cutover where the regular observer cohort jumps from six nodes and two clients to fifteen nodes and four clients."
authors: [aubury]
tags: [ethereum, data, execution, clients, xatu]
date: 2026-07-12T19:31:02+10:00
---

`engine_newPayload` just gained another three and a half months of history. That is useful, but the new line has a seam in it: on March 27, the regular-node sample jumps from six observers and two execution clients to as many as fifteen observers and four clients.

If you plot "fastest client" straight through that seam, Nethermind appears to improve from **47.5% of observed slots to 94.9%** in two days. It did not suddenly get twice as fast. Nine more runners walked onto the track.

<!-- truncate -->

<img src="/img/engine-newpayload-history-cutover.png" alt="Two-panel chart showing the regular engine newPayload observer cohort jumping from six nodes and two implementations to fifteen nodes and four implementations at the March 27 source cutover, while Nethermind's apparent fastest-call share jumps from 47.5% to 94.9%." loading="eager" />

The change came from a sensible [backfill](https://github.com/ethpandaops/xatu-cbt/pull/293). `mainnet.int_engine_new_payload` used to start with the execution-side RPC snooper on March 27. The model now uses the older consensus-side `consensus_engine_api_new_payload` capture before that point, then switches to `execution_engine_new_payload` once the snooper exists. The exact mainnet boundary in the raw table is **2026-03-27 04:44:12.269 UTC**.

The two clocks are close enough for same-node comparisons, but the regular-node population is not. This is the daily query behind the top panel:

```sql
SELECT
  toDate(slot_start_date_time) AS day,
  meta_execution_implementation AS implementation,
  uniqExact(meta_client_name) AS observer_nodes,
  uniqExact(slot) AS observed_slots,
  quantileExact(0.5)(duration_ms) AS p50_ms
FROM mainnet.int_engine_new_payload FINAL
WHERE node_class = ''
  AND status = 'VALID'
  AND meta_execution_implementation != ''
  AND slot_start_date_time >= toDateTime('2026-03-13 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-04-11 00:00:00')
GROUP BY day, implementation
ORDER BY day, implementation;
```

From March 13 through March 26, every complete day has the same regular cohort: five go-ethereum observers and one Nethermind observer. March 27 is mixed because the snooper starts at 04:44 UTC. On March 28, the first complete post-cutover day, the model has nine go-ethereum observers, two Nethermind, three Erigon and one Besu.

That is **6 nodes becoming 15**, with Erigon and Besu appearing at the source boundary. The post-cutover cohort then moves between 13 and 15 daily observers through April 10. These are instrumented observer nodes, not client market share and certainly not an Ethereum-wide benchmark.

The lower panel uses the tie-aware winner table. A client gets a win when its best valid observation matches the minimum `duration_ms` for that slot and node class:

```sql
WITH slots AS (
  SELECT
    toDate(slot_start_date_time) AS day,
    uniqExact(slot) AS observed_slots
  FROM mainnet.int_engine_new_payload_fastest_execution_by_node_class FINAL
  WHERE node_class = ''
    AND slot_start_date_time >= toDateTime('2026-03-13 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-04-11 00:00:00')
  GROUP BY day
)
SELECT
  w.day_start_date AS day,
  w.meta_execution_implementation AS implementation,
  w.win_count,
  s.observed_slots,
  round(100 * w.win_count / s.observed_slots, 4) AS win_pct
FROM mainnet.fct_engine_new_payload_winrate_daily AS w FINAL
GLOBAL INNER JOIN slots AS s ON w.day_start_date = s.day
WHERE w.node_class = ''
  AND w.day_start_date >= toDate('2026-03-13')
  AND w.day_start_date <  toDate('2026-04-11')
ORDER BY day, implementation;
```

On March 26, Nethermind wins 3,411 of 7,177 observed slots (**47.53%**) and go-ethereum wins 3,854 (**53.70%**). By March 28, Nethermind wins 6,818 of 7,187 slots (**94.87%**); go-ethereum falls to 286 (**3.98%**) and Erigon gets 95 (**1.32%**). Ties award a win to every tied implementation, so these shares can add to slightly more than 100%.

I wanted to make sure this was not merely the extra 2-7 ms of consensus-side request marshalling mentioned in the backfill change. For March 28, I fetched the two raw sources separately, kept `status = 'VALID'`, excluded the `eip7870-block-builder` class, deduped by `(block_hash, meta_client_name, implementation)`, and joined the bounded results locally. The execution-side range was blocks **24,752,337 through 24,759,518**.

```sql
-- Consensus-side rows. Run separately from the execution-side query.
SELECT
  block_hash,
  meta_client_name,
  meta_execution_implementation AS implementation,
  argMin(duration_ms, tuple(event_date_time, updated_date_time)) AS consensus_ms
FROM default.consensus_engine_api_new_payload FINAL
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-03-28 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-03-29 00:00:00')
  AND status = 'VALID'
  AND meta_execution_implementation != ''
  AND positionCaseInsensitive(meta_client_name, '7870') = 0
GROUP BY block_hash, meta_client_name, implementation;

-- Execution-side rows, joined locally on the three selected key columns.
SELECT
  block_hash,
  meta_client_name,
  meta_execution_implementation AS implementation,
  argMin(duration_ms, tuple(event_date_time, updated_date_time)) AS snooper_ms
FROM default.execution_engine_new_payload FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 24752337 AND 24759518
  AND event_date_time >= toDateTime('2026-03-28 00:00:00')
  AND event_date_time <  toDateTime('2026-03-29 00:00:00')
  AND status = 'VALID'
  AND meta_execution_implementation != ''
  AND positionCaseInsensitive(meta_client_name, '7870') = 0
GROUP BY block_hash, meta_client_name, implementation;
```

There were **43,116 same-node, same-payload pairs** across the six regular observers present in both sources. The consensus-side duration was 6 ms higher at the median, but the two captures agreed on the exact winning implementation set for **6,856 of 7,186 payloads, or 95.4%**. More importantly, those same six observers told almost the same story in both clocks: Nethermind won 44.6% on the consensus capture and 43.0% on the snooper capture. Only after including the snooper's nine additional regular observers did Nethermind's apparent share become 95.8%.

So the longer history is real, and the two duration clocks are compatible enough for the overlapping nodes. The regular-node win-rate series is still not continuous across March 27 because the cohort is different. Any chart crossing that date needs a source boundary, a same-node cohort, or two separately labelled eras. Otherwise it turns an observer rollout into a client performance event.
