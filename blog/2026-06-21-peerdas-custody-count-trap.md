---
slug: peerdas-custody-count-trap
title: PeerDAS has a custody count trap
description: Seven days of mainnet consensus ENRs show a lumpy PeerDAS custody surface. The cgc=0 peers were only 6% of discovered nodes, but they missed 66.5% of custody probes.
authors: aubury
tags: [ethereum, peerdas, p2p, data]
date: 2026-06-21
---

PeerDAS has a tiny ENR field called `cgc`.

It is supposed to say how many custody groups a peer has. The boring answer would be: most peers advertise the minimum, a few advertise more, and probe results roughly follow that.

The boring answer was wrong.

<!-- truncate -->

<img src="/img/peerdas-custody-count-trap.png" alt="PeerDAS custody group count distribution and custody probe missing rates" loading="eager" />

The spec gives the scale. Mainnet has **128 custody groups**. The protocol minimum is **4**. Validators are expected to custody **8**. The [p2p spec](https://github.com/ethereum/consensus-specs/blob/master/specs/fulu/p2p-interface.md#custody-group-count) also says `cgc` is a uint64 in the ENR, and that zero is encoded as an empty byte string.

So `0x04` is not a random hex blob. It means 4.

`0x80` means 128.

`0x` means zero.

That last one is where the data gets annoying.

Across the seven complete UTC days from June 14 through June 20, I took the latest `node_record_consensus` row per discovered mainnet `node_id`. That gave **3,334** consensus ENRs.

The distribution was not just "everyone does the minimum":

- **31.7%** advertised `cgc=4`, the minimum.
- **22.6%** advertised `cgc=8`, the validator requirement.
- **24.8%** advertised `cgc=128`, full custody.
- **14.8%** advertised some other explicit nonzero value.
- **6.1%** advertised `cgc=0`.

The zero bucket was small, but it behaved completely differently.

I joined those latest ENRs to `mainnet.int_custody_probe`, grouped by the advertised `cgc`, and counted probe results. Peers with explicit nonzero `cgc` values were boring in the good way. They mostly worked.

The `cgc=0` peers did not.

```python
START = "2026-06-14 00:00:00"
END = "2026-06-21 00:00:00"

latest_enr = clickhouse.query("clickhouse-raw", f"""
SELECT
  node_id,
  argMax(peer_id_unique_key, event_date_time) AS peer_id_unique_key,
  argMax(cgc, event_date_time) AS cgc,
  argMax(implementation, event_date_time) AS implementation,
  argMax(version, event_date_time) AS version
FROM node_record_consensus
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('{START}')
  AND event_date_time <  toDateTime('{END}')
GROUP BY node_id
""")

probe_stats = clickhouse.query("clickhouse-refined", f"""
SELECT
  peer_id_unique_key,
  count() AS probes,
  countIf(result = 'success') AS success,
  countIf(result = 'missing') AS missing,
  countIf(result = 'failure') AS failure,
  quantileExact(0.5)(response_time_ms) AS p50_ms,
  quantileExact(0.95)(response_time_ms) AS p95_ms
FROM mainnet.int_custody_probe
WHERE probe_date_time >= toDateTime('{START}')
  AND probe_date_time <  toDateTime('{END}')
GROUP BY peer_id_unique_key
""")

matched = probe_stats.merge(
    latest_enr[["peer_id_unique_key", "cgc", "implementation", "version"]],
    on="peer_id_unique_key",
    how="inner",
)

matched.groupby("cgc").agg(
    peers=("peer_id_unique_key", "count"),
    probes=("probes", "sum"),
    missing=("missing", "sum"),
    failures=("failure", "sum"),
)
```

The matched probe set had the shape I care about:

<table style={{ width: '100%' }}>
  <thead>
    <tr>
      <th>ENR <code>cgc</code> bucket</th>
      <th style={{ textAlign: 'right' }}>Probed peers</th>
      <th style={{ textAlign: 'right' }}>Probes</th>
      <th style={{ textAlign: 'right' }}>Missing rate</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>0x</code> / zero</td>
      <td style={{ textAlign: 'right' }}>54</td>
      <td style={{ textAlign: 'right' }}>87,835</td>
      <td style={{ textAlign: 'right' }}><strong>66.51%</strong></td>
    </tr>
    <tr>
      <td><code>0x04</code> / 4</td>
      <td style={{ textAlign: 'right' }}>910</td>
      <td style={{ textAlign: 'right' }}>2,314,976</td>
      <td style={{ textAlign: 'right' }}>1.62%</td>
    </tr>
    <tr>
      <td><code>0x08</code> / 8</td>
      <td style={{ textAlign: 'right' }}>748</td>
      <td style={{ textAlign: 'right' }}>1,761,312</td>
      <td style={{ textAlign: 'right' }}>1.74%</td>
    </tr>
    <tr>
      <td><code>0x80</code> / 128</td>
      <td style={{ textAlign: 'right' }}>807</td>
      <td style={{ textAlign: 'right' }}>1,864,478</td>
      <td style={{ textAlign: 'right' }}><strong>0.25%</strong></td>
    </tr>
    <tr>
      <td>other explicit nonzero</td>
      <td style={{ textAlign: 'right' }}>482</td>
      <td style={{ textAlign: 'right' }}>1,162,345</td>
      <td style={{ textAlign: 'right' }}>1.16%</td>
    </tr>
  </tbody>
</table>

The unmatched probe baseline was **1.54%** missing, so the minimum-custody peers were basically normal. The full-custody peers were cleaner than normal.

The zero peers were not normal at all.

They were not timing out slowly either. The median peer-level p50 response time in the `cgc=0` bucket was **33 ms**, and the median peer-level p95 was **120 ms**. That looks like a fast "I do not have this" path, not a slow network path.

There is one more uncomfortable detail: all **202** latest ENRs in the zero bucket identified as **Erigon/Caplin**. The probed zero bucket was also Erigon/Caplin: 54 peers, 87,835 probes, 66.5% missing.

That does not mean "Erigon is 6% of mainnet". It does not even mean 6% of validators. `node_record_consensus` is a discoverable peer-surface sample, and the probe table is whatever Xatu managed to probe. Treat it like a P2P surface, not a census.

But as a P2P surface, the pattern is pretty clear.

`cgc=4` is not the danger sign. Minimum custody peers mostly served what they said they served.

`cgc=0` is the danger sign. It is not just a smaller custody count. In this sample, it marked peers that were discoverable, fast, and usually useless for the requested data column.

That is the trap.

If you are building PeerDAS peer selection from ENRs, do not average zero into the same mental bucket as 4 or 8. It is a hole. Treat it like one.
