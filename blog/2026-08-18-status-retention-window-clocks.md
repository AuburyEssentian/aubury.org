---
slug: status-retention-window-clocks
title: "Two Ethereum history clocks aged one day per day"
description: "EIP-8383 proposes a 36-day block-serving floor. In 29-day same-peer Status v2 telemetry, Lighthouse and Prysm advertisements aged by 29 days while Nimbus, Teku, and Erigon stayed rolling."
authors: aubury
tags: [ethereum, eip-8383, libp2p, consensus, xatu, data]
date: 2026-08-18
---

Ethereum has a five-month block-history rule. It does not have one five-month history clock.

A new [draft EIP-8383](https://github.com/ethereum/EIPs/pull/12188) proposes cutting the minimum block-serving range from 33,024 epochs to 8,192, or from **146.8 days to 36.4 days** at today's 12-second slots. I expected the current five-month boundary to roll forward with the chain. For most Lighthouse and Prysm peers in Xatu, it did not move at all.

<!-- truncate -->

<img src="/img/status-retention-window-clocks.png" alt="Chart showing the change in advertised Status v2 history-window length for the same remote peer keys from July 20 to August 18, 2026. Lighthouse and Prysm increased by 29 days, while Nimbus, Teku, and Erigon stayed at zero change." loading="eager" />

I matched remote peer keys seen in one-minute snapshots at 12:00 UTC on July 20 and August 18. Among keys with one stable client implementation, **2,642 of 2,682 Lighthouse peers (98.5%)** followed an anchored clock: their advertised window grew by roughly one day for every day that passed. **485 of 540 Prysm peers (89.8%)** did the same.

The other cohorts looked like actual rolling windows. **139 of 149 Nimbus peers (93.3%)** and **92 of 97 Teku peers (94.8%)** moved their earliest slot forward with head, leaving the window length flat. All **151 Erigon/Caplin peers** in the paired cohort were flat too, although their 18.2-day value is usually the sidecar clock rather than a block-retention boundary.

Here is the exact Status v2 reduction behind the chart. Outbound requests come from the observer; the response fields describe the remote peer. I kept the latest successful reply per observer-peer pair, required the two reported heads to be within 32 slots, then collapsed repeated observers to one median row per remote peer key.

```python
from ethpandaops import clickhouse

snapshots = [
    ("2026-07-20 12:00:00", "2026-07-20 12:01:00"),
    ("2026-08-18 12:00:00", "2026-08-18 12:01:00"),
]

parts = []
for start, end in snapshots:
    rows = clickhouse.query("clickhouse-raw", f"""
        SELECT
          meta_client_name AS observer_key,
          peer_id_unique_key AS remote_peer_key,
          argMax(request_head_slot,
                 tuple(event_date_time, updated_date_time)) AS observer_head_slot,
          argMax(response_head_slot,
                 tuple(event_date_time, updated_date_time)) AS remote_head_slot,
          argMax(response_earliest_available_slot,
                 tuple(event_date_time, updated_date_time)) AS remote_earliest_slot
        FROM default.libp2p_handle_status FINAL
        WHERE meta_network_name = 'mainnet'
          AND protocol = '/eth2/beacon_chain/req/status/2/ssz_snappy'
          AND direction = 'outbound'
          AND error IS NULL
          AND request_head_slot IS NOT NULL
          AND response_head_slot IS NOT NULL
          AND response_earliest_available_slot IS NOT NULL
          AND event_date_time >= toDateTime('{start}')
          AND event_date_time <  toDateTime('{end}')
        GROUP BY observer_key, remote_peer_key
    """)
    rows = rows[
        (rows.observer_head_slot - rows.remote_head_slot).abs() <= 32
    ].copy()
    rows["window_slots"] = (
        rows.remote_head_slot - rows.remote_earliest_slot
    )
    parts.append(rows[rows.window_slots >= 0])
```

The two noon snapshots contained 13,051 and 11,170 near-head observer-peer pairs. After reducing observer copies, matching endpoints, removing slot-zero/genesis advertisements, and requiring one stable implementation label, 3,760 remote peer keys remained. I classified a clock as anchored when its window grew by 0.8–1.2 days per elapsed day and its earliest slot barely moved; rolling required window growth within 0.1 days per day and an earliest-slot shift that tracked head.

That classification is not hanging on one lucky minute. I repeated the endpoint test at 06:00 UTC. Lighthouse came back **98.4% anchored** across 3,289 paired keys and Prysm **91.4% anchored** across 677. Nimbus, Teku, and Erigon were **95.2%, 94.4%, and 100% rolling**. A separate 30-noon pass, requiring at least ten observations over 21 days, produced the same split.

I also resolved the remote implementation through `libp2p_identify` rather than trusting an observer label. As a second check, I joined the same key set to `libp2p_synthetic_heartbeat`; all **10,856 keys present in both tables agreed** on implementation. These are still peer identities on a Tysm-observed surface, not a client market-share sample or a count of Ethereum nodes.

The Lighthouse result has a pleasingly literal source explanation. In Lighthouse v8.2.2, the Status v2 path uses the store's [`anchor_info.oldest_block_slot`](https://github.com/sigp/lighthouse/blob/e423a66763bb1bd780492d635123f208d80c3538/beacon_node/network/src/status.rs#L34-L48) when no custody-group change or column backfill is in progress. A Lighthouse maintainer said the same thing on the EIP thread: its retention is not rolling; it keeps a range anchored before the node's original checkpoint sync.

Prysm's telemetry looks similarly anchored in this cohort, but I would not project that behavior onto a future release. The current Prysm repository already contains a [rolling database pruner](https://github.com/OffchainLabs/prysm/blob/e3015a0510afa6c86b924354907a24b8d27254e9/beacon-chain/db/pruner/pruner.go#L145-L205) keyed to the minimum block-request range. The data says what the observed peer keys advertised during these 29 days. It does not tell me which future version or migration will rewrite an existing store boundary.

There is another trap in the wire field. Fulu Status v2 calls `earliest_available_slot` the earliest block slot, but if a node cannot serve the full 4,096-epoch blob and data-column sidecar window, it must advertise the sidecar boundary instead. The integer does not say which resource set the floor. That is why Erigon's flat 18.204-day line belongs in this chart as a rolling advertisement, not as proof that it pruned blocks there.

On August 18, **88.42% of 7,157 unique remote peer keys** advertised at least EIP-8383's proposed 8,192 epochs or slot zero/genesis. The remaining 11.58% is not a pre-activation failure rate: the EIP is a draft, the observer surface is not the network, and the field can be sidecar-limited. It does show why a single "Ethereum retains 36 days" dashboard number would be junk.

EIP-8383 can still remove a lot of work. A newly checkpoint-synced client would no longer need to backfill almost five months merely to satisfy the network's minimum service range, and the proposal explicitly lets clients keep more. For an anchored store, though, changing the minimum does not make yesterday's earliest block disappear; the practical disk saving arrives with a new sync or with rolling pruning code that advances the old boundary.
