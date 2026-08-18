---
slug: teku-fork-schema-gossip
title: "Teku stayed near head while its data-column gossip counter was zero"
description: "On Plataberget, 15 Teku observers processed zero Fulu data-column gossip before a one-line fork-schema fix. The same nodes recorded 114,383 validator submissions in the matched window after rollout."
authors: aubury
tags: [ethereum, teku, peerdas, plataberget, data]
date: 2026-08-18
---

Teku followed Plataberget with a broken data-column gossip decoder. That sounds impossible until you remember PeerDAS has more than one way to recover data.

Across 15 continuously observed Teku nodes, not one data-column sidecar reached the gossip validator during the matched 30-minute window before the patched build arrived. The same 15 nodes submitted **114,383** sidecar messages to that validator in the window after rollout, and **83,684** passed gossip verification.

<!-- truncate -->

This was not a quiet testnet. Every one of the 59 covered Grandine, Lighthouse, Lodestar, and Prysm control nodes had a positive processing counter before the Teku update. The zero belonged to Teku.

<img src="/img/teku-fork-schema-gossip.png" alt="Matched before-and-after chart for 15 Teku observers on Plataberget: validator submissions rose from 0 to 114,383 and gossip-verified messages rose from 0 to 83,684 after the patched build; all 59 non-Teku control observers were already non-zero, while median and p95 head lag remained one and two slots" loading="eager" />

## The wrong fork had the decoder

[Plataberget](https://notes.ethereum.org/@ethpandaops/glamsterdam-devnet-8) launched on August 13 as a short-lived fork-transition network. It runs Fulu first, with Gloas scheduled for epoch 1536 on August 20. That future fork was enough to expose a nasty little schema mistake.

Teku subscribed to a Fulu `data_column_sidecar` gossip topic but selected the SSZ decoder for its highest supported milestone, which was already Gloas. Fulu sidecars include a signed block header; the Gloas form does not. The bytes were valid for the topic and wrong for the decoder, so deserialization failed before the message could reach `DataColumnSidecarGossipValidator.validate()`.

The [fix](https://github.com/Consensys/teku/pull/11128) changed one schema lookup. Instead of choosing `spec.forMilestone(getHighestSupportedMilestone())`, Teku now chooses `spec.atEpoch(forkInfo.getFork().getEpoch())`: decode the message with the fork named by its topic, not the latest fork the binary happens to understand. Commit [`c1902212cb`](https://github.com/Consensys/teku/commit/c1902212cba7938251f7baa4b5cf0473d258b820) merged at 04:27:55 UTC and appeared across the observed devnet fleet between 04:51:30 and 04:52:30 UTC.

The metric boundary matters here. Teku defines `beacon_data_column_sidecar_processing_requests_total` as the number of sidecars submitted for processing, and increments it on the first line of `validate()`. Its success counter increments only when a sidecar has been verified for gossip. A decode failure upstream of that method should therefore leave both counters untouched. That is exactly what the old build did.

## Zero really meant zero

I aligned the counters to each node's own version history instead of drawing a fleet-wide line through a rolling deployment. All 15 current Teku observers exposed both the old and patched build with no more than five minutes between the last old sample and first new sample. For each node I kept a 30-minute window on either side and threw away the ten minutes nearest the restart.

The actual Panda path was Prometheus range data at 30-second resolution. The reduction retained the stable observer key internally, required at least 50 samples in both windows, and summed only positive counter deltas so a reset could not become negative traffic.

```python
from ethpandaops import prometheus

network = "glamsterdam-devnet-8"
start = "2026-08-18T03:15:00Z"
end = "2026-08-18T06:14:00Z"
step = "30s"

versions = prometheus.query_range(
    "devnets",
    f'beacon_teku_version_total{{network="{network}"}}',
    step,
    start=start,
    end=end,
)["result"]

requests = prometheus.query_range(
    "devnets",
    f'beacon_data_column_sidecar_processing_requests_total'
    f'{{network="{network}",consensus_client="teku"}}',
    step,
    start=start,
    end=end,
)["result"]

successes = prometheus.query_range(
    "devnets",
    f'beacon_data_column_sidecar_processing_successes_total'
    f'{{network="{network}",consensus_client="teku"}}',
    step,
    start=start,
    end=end,
)["result"]

# Per stable observer:
#   first_new = first sample with version 26.8.0+30-gc1902212cb
#   pre  = positive_delta(counter, first_new - 40m, first_new - 10m)
#   post = positive_delta(counter, first_new + 10m, first_new + 40m)
# Keep only observers with old/new version continuity and >= 50 samples per window.
```

Before the update, the fleet recorded **0 processing requests and 0 gossip successes**. After it, all 15 nodes were non-zero: **114,383 processing requests** and **83,684 successes**, a 73.16% success share. Those are node-message processing events, not unique network sidecars. The same sidecar can reach several observers, and one observer may see more than one copy.

The cross-client control used the same counter, fixed UTC windows, and the same coverage floor. Before Teku changed version, the counter was positive on 14 of 14 Grandine nodes, 15 of 15 Lighthouse nodes, 15 of 15 Lodestar nodes, and 15 of 15 Prysm nodes. I did not compare the clients' raw totals because implementations can place otherwise similar counters at slightly different boundaries. The useful comparison is the blunt one: 59 of 59 controls moved; 0 of 15 Teku nodes did.

## The chain did not fall over

The original [bug report](https://github.com/Consensys/teku/issues/11120) says Teku could continue syncing data columns over request/response, although some early nodes later fell behind after restarts. I cannot prove that outbound recovery path from the metric names alone. One tempting series, `network_rpc_data_column_sidecars_by_root_requests_total`, is explicitly an inbound server counter: requests received from peers. Its companion counts sidecar units named in accepted requests before Teku knows how many it will return.

I queried those counters anyway. In the pre-fix window, peers sent these Teku nodes 1,311 accepted by-root requests naming 172,770 sidecar units. That establishes busy request/response traffic around the broken gossip path, but it does not establish direction of recovery, successful replies, or unique columns. Calling it Teku's fallback fetch count would be neat and wrong.

Head telemetry gives a narrower check. At each 30-second sample I compared a paired Teku node's head slot with the fastest live observer on the network and excluded zero-valued startup samples. The median lag was one slot before and after the rollout; p95 was two slots in both windows. Of 793 usable node-samples per window, 96.60% were within two slots before the fix and 98.99% after it.

That is not a finality proof, and scrape timing makes a one-slot difference unsurprising. It does rule out the easy story where the zero counter merely describes 15 dead nodes. The nodes were near the live head while the Fulu gossip decoder fed nothing into its validator.

This is the kind of bug a transition testnet is supposed to catch. The wire format was fine, the topic was fine, and the client understood both forks. The mistake lived in the choice between "the fork this message belongs to" and "the newest fork I know about."

One line fixed it. The counters made the boundary painfully obvious.
