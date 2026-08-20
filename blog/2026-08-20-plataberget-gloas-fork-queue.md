---
slug: plataberget-gloas-fork-queue
title: "Plataberget's 16,306-deposit fork boundary"
description: "At Plataberget's Gloas fork, Lodestar and Nimbus reported a post-fork head in 21 seconds median. Prysm and Teku took about 93 minutes."
authors: aubury
tags: [ethereum, gloas, plataberget, consensus, clients, panda]
date: 2026-08-20
---

Plataberget's Gloas fork looked like an epoch boundary until the head metrics stopped moving. Lodestar and Nimbus reported a post-fork head in **21 seconds median**. Prysm and Teku did not get there for roughly **93 minutes**.

The fork was not just a version switch. It walked **16,306 pending deposits** to build Gloas's new payload-builder registry, and the way clients handled that queue decided who crossed quickly.

<!-- truncate -->

<img src="/img/plataberget-gloas-fork-queue.png" alt="Dark log-scale dot plot of first post-fork head delays for 14 validator nodes per consensus client at Plataberget slot 49,152. Lodestar and Nimbus have 21-second medians, Grandine 2 minutes 36 seconds, Lighthouse 75 minutes 51 seconds, Teku 92 minutes 36 seconds, and Prysm 93 minutes 51 seconds. One Grandine, Lighthouse, Teku, and Prysm node was still pre-fork at 11:15 UTC. A callout shows 16,306 pending deposits, 10,033 builder pubkeys, and Lodestar's 0.330-second median onboarding step with 15,337 cached and zero inline BLS checks." loading="eager" />

## The split

The fork activated at epoch 1,536, slot 49,152, at **07:50:24 UTC on August 20**. Plataberget's [public inventory](https://github.com/ethpandaops/glamsterdam-devnets/blob/master/ansible/inventories/devnet-8/inventory.ini) had 84 validator-carrying beacon nodes in the comparison: six consensus clients, seven execution-client pairings, and two nodes per pairing. I filtered out bootnodes, buildoor nodes, and execution exporters before touching the numbers.

This is the executed Panda reduction. The row grain is one Prometheus series per beacon-node instance, not one scrape and not one validator:

```python
from ethpandaops import prometheus
from statistics import median

fork_ts = 1787212224
fork_slot = 49_152

raw = prometheus.query_range(
    "devnets",
    'beacon_head_slot{'
    'network="glamsterdam-devnet-8",'
    'job="consensus_node",supernode="True"}',
    step="15s",
    start="2026-08-20T07:44:00Z",
    end="2026-08-20T11:15:00Z",
)

by_client = {}
for series in raw["result"]:
    client = series["metric"]["consensus_client"]
    values = [(float(t), float(v)) for t, v in series["values"]]
    delay = next(
        (t - fork_ts for t, v in values if t >= fork_ts and v >= fork_slot),
        None,
    )
    by_client.setdefault(client, []).append(delay)

summary = {
    client: {
        "median_seconds": median(x for x in delays if x is not None),
        "crossed": sum(x is not None for x in delays),
        "nodes": len(delays),
    }
    for client, delays in by_client.items()
}
```

| Client | Median first post-fork head | Crossed by 11:15 |
|---|---:|---:|
| Lodestar | 21 s | 14 / 14 |
| Nimbus | 21 s | 14 / 14 |
| Grandine | 2m 36s | 13 / 14 |
| Lighthouse | 75m 51s | 13 / 14 |
| Teku | 92m 36s | 13 / 14 |
| Prysm | 93m 51s | 13 / 14 |

The 15-second scrape interval means these are first-observed delays, not nanosecond timings for the upgrade function. They still separate cleanly. Every Lodestar and Nimbus node crossed within 36 seconds, every observed Grandine crossing happened within 9 minutes 21 seconds, and no Prysm or Teku node crossed in the first hour.

This was not missing telemetry dressed up as a stall. All 84 head series had samples before and after the fork. For Prysm, 13 of 14 `process_start_time_seconds` series did not change through the window, so those nodes stayed up while their reported head remained below slot 49,152.

## The queue hiding inside the fork

Gloas starts with an empty builder registry. At the fork boundary, [the spec's builder-onboarding function](https://github.com/ethereum/consensus-specs/blob/v1.7.0-alpha.8/specs/gloas/fork.md#new-onboard_builders_from_pending_deposits) walks the existing deposit queue, decides which deposits belong to validators or builders, checks signatures, and constructs the registry. The spec note is unusually direct: implementations should validate pending-deposit signatures before the fork and cache the answers because the queue might be large.

Plataberget made "might be large" concrete. Lodestar's pre-fork gauges agreed on all 14 validator nodes:

- **16,306** pending deposits, all 16,306 scanned and cached;
- **10,033** distinct builder pubkeys tracked;
- **15,337** signature checks served from cache during onboarding;
- **zero** BLS checks run inline on the fork transition's critical path.

I queried the gauges and transition metrics separately rather than adding Prometheus scrapes together:

```python
metric_names = [
    "lodestar_builder_deposit_preverify_pending_deposits",
    "lodestar_builder_deposit_preverify_scanned_deposits",
    "lodestar_builder_deposit_preverify_cached_deposits",
    "lodestar_builder_deposit_preverify_builder_pubkeys",
    "lodestar_stfn_gloas_onboard_builders_signature_checks",
]

for name in metric_names:
    result = prometheus.query(
        "devnets",
        f'{name}{{network="glamsterdam-devnet-8",'
        'job="consensus_node",supernode="True"}',
    )
```

The first increment in Lodestar's `onboard_builders_seconds_sum` ranged from **0.226 to 0.458 seconds**, with a **0.330-second median** across the 14 nodes. That number covers the deposit-onboarding phase, not the whole fork upgrade or the wait for a head block. It does show that preverification and Lodestar's append-only builder-registry path kept the ugly loop off the critical path.

There is a second check outside the metric family. [Tracoor](https://tracoor.glamsterdam-devnet-8.ethpandaops.io) fetched 14 slot-49,152 states from Lodestar and Nimbus at about 07:50:30 UTC. All 14 had the same state root, `0x6f6205ae...d6d025`, and the same content hash. The two clients that crossed first were not merely incrementing a local head counter; they agreed on the post-fork state bytes.

## Prysm found the quadratic path

All 14 Prysm nodes reported v7.1.8 commit [`d790f667`](https://github.com/OffchainLabs/prysm/commit/d790f66706581db3c1fa77b0d9a2e7e3940049c5) immediately before the fork. In that code, each builder candidate could call `IsPendingValidator` over earlier deposits with the same pubkey and verify those signatures again. A queue shape with repeated pubkeys turns the fork-boundary scan into far more work than the row count suggests.

Prysm maintainers opened [PR #17387](https://github.com/OffchainLabs/prysm/pull/17387) during the incident. Its reproduction says Devnet-8 triggered millions of redundant checks and stalled Prysm at the Gloas fork. The patch caches pending-validator status by pubkey, remembers deposit verification by hash-tree root, and makes each pending deposit hit BLS verification at most once. The code change matches the failure visible in the head series; the PR was still open at the end of this measurement window.

I do not have the same code-level attribution for Teku or Lighthouse. Their head delays are measured, but this post does not claim they hit Prysm's exact bug. It also is not a general client benchmark: this is one purpose-built devnet, one large synthetic queue, and a delay that includes the state transition, catch-up, and head selection.

## Why finality stopped

The inventory assigned 1,000 validator keys to each of the 84 validator nodes. Lodestar and Nimbus therefore put about one-third of the configured validator set across the fork in the first minute. Grandine raised that to 41 of 84 nodes within ten minutes, still short of the two-thirds effective-balance threshold needed for finality.

The finality metrics fit that arithmetic. `beacon_finalized_epoch` reached 1,534 and stayed there through 11:15 UTC while the fastest heads reached slot 50,109, in epoch 1,565. That is a 31-epoch gap. Node counts are only a proxy for effective balance, but the keys were deliberately distributed evenly here, and the proxy is not close to the threshold.

This is what a useful devnet failure looks like. The spec said the queue could be slow; Plataberget supplied 16,306 deposits and turned "slow" into an hour and a half. Caching was not a micro-optimization. It was the fork.
