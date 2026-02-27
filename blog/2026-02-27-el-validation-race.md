---
title: "The EL Validation Race: Reth Cut Block Processing Time 25% in 30 Days"
description: "Reth validates blocks in 35ms. Erigon takes 200ms. Besu is slowing down. And a new Rust client called ethrex is right on Reth's heels — with nightly builds and one monitoring node."
authors: [aubury]
tags: [ethereum, execution-clients, reth, performance, engine-api]
date: 2026-02-27
---

Every 12 seconds, your execution client gets a new block and has to tell the consensus layer: valid or not. The call is `engine_newPayload`, and how long it takes determines how fast your validator can attest to the new head.

That window matters. A faster EL client means earlier head votes, better attestation accuracy, and more flexibility in how you run your validator. The timing game, MEV extraction, and late block handling all happen inside this gap.

So which execution client is fastest? The data is messier than the win-rate leaderboards suggest.

<!-- truncate -->

## What the data actually shows

The ethpandaops monitoring network records every `engine_newPayload` call from its fleet of sentry nodes — each running one EL client. That's tens of thousands of raw observations per day per client, enough to compute real median validation times.

```sql
-- Source: xatu execution_engine_new_payload
-- Filter: mainnet, status = VALID, last 30 days
SELECT 
    toDate(event_date_time)             AS day,
    meta_execution_implementation       AS client,
    count()                             AS obs,
    quantileExact(0.5)(duration_ms)     AS p50_ms,
    quantileExact(0.95)(duration_ms)    AS p95_ms
FROM execution_engine_new_payload
WHERE meta_network_name = 'mainnet'
  AND status = 'VALID'
GROUP BY day, client
```

Across the six clients tracked over the last month, the picture is striking.

![EL validation race](/img/el-validation-race.png)

Three tiers emerge clearly on the log scale:

| Client | 30-day p50 | Change |
|---|---|---|
| Reth | 40ms avg, **35ms now** | ↓ 25% |
| ethrex | 41ms avg, **37ms now** | ↓ 16% |
| Nethermind | 45ms avg, **~48ms now** | ↓ 7% |
| Geth | 75ms avg | stable |
| Besu | 156ms avg, **171ms now** | ↑ 15% |
| Erigon | 210ms avg, range 171–301ms | volatile |

The gap is substantial. At the 95th percentile, Erigon takes over a second to validate blocks that Reth processes in under 100ms.

## Reth's monthly sprint

Reth went from 47ms to 35ms p50 over these 30 days — a 25% improvement that happened in two steps. The first step came around Feb 9–10, when development builds in the 1.10.2 series dropped from 47ms to around 34ms. The second step came when 1.11.0-dev builds started appearing on Feb 13, pushing median time to the 31–32ms range.

```sql
-- Reth version timeline, raw xatu
SELECT 
    toDate(event_date_time)         AS day,
    meta_execution_version          AS version,
    quantileExact(0.5)(duration_ms) AS p50_ms,
    count()                         AS obs
FROM execution_engine_new_payload
WHERE meta_execution_implementation = 'Reth'
  AND event_date_time >= now() - INTERVAL 30 DAY
  AND status = 'VALID'
GROUP BY day, version
ORDER BY day, obs DESC
```

The old 1.9.3 nodes — still running in the monitoring fleet on unchanged hardware — consistently show 41–50ms. The newer 1.11.1 builds run at 29–31ms. Same machine, same blocks, different software: a 36% gap between two adjacent version families.

This is what rapid iteration through nightly development builds looks like in validation timing data.

## ethrex: one node, nightly builds, matching the leader

There's a sixth execution client in the raw xatu data that doesn't appear on any major "client diversity" leaderboard yet: **ethrex**, built by Lambda Class in Rust.

```sql
-- ethrex is in the raw data (meta_execution_implementation = 'ethrex')
-- First observation: 2026-01-29
-- Node count: 1
-- Version format: 9.0.0-{short_commit_hash}
-- New build every 1–2 days
```

One monitoring node, a new build almost every day. The version string changes daily (`9.0.0-17f0f3bf`, `9.0.0-7839747f`, etc. — each one a fresh nightly commit). And the performance tells a story: ethrex started at 44ms p50 in late January and has been tracking Reth downward since, landing at 35–37ms over the last week.

At this level of performance, ethrex is already competitive with production Reth. It's been running on mainnet, it's getting faster, and the trajectory closely mirrors Reth's. Whether it expands beyond one monitoring node is the next question.

## The win-rate problem

There's a popular way to benchmark EL client speed: count how many slots each client "wins" — i.e., for each block, which client type was fastest to return VALID.

```sql
-- Source: xatu-cbt mainnet.fct_engine_new_payload_winrate_daily
SELECT el_client, sum(win_count) as wins
FROM mainnet.fct_engine_new_payload_winrate_daily
WHERE day_start_date >= today() - 30
GROUP BY el_client
ORDER BY wins DESC
-- Result: Nethermind 68%, Reth 28%, Erigon 1.9%, Geth 1.3%, Besu 0.4%
```

Nethermind wins 68% of blocks. Reth wins 28%. But we just established that Reth is actually faster than Nethermind in absolute terms (35ms vs 50ms median).

The reason: the win rate measures how often any node of that client type was fastest. If the monitoring fleet has 56 Nethermind nodes and 23 Reth nodes, Nethermind has 2.4× more shots at the fastest response in any given slot. The best of 56 Nethermind observations will often beat the best of 23 Reth observations, even if the underlying Reth nodes are individually faster.

Win rates measure "how many nodes you have × how fast they are." Median validation time measures just how fast. They're different things, and only one of them matters for your individual validator.

Today (Feb 27), Reth and Nethermind have reached rough parity on win counts — the first time Reth has matched Nethermind's pace in these 30 days. This is a monitoring-fleet-composition story as much as a software story.

## Besu is moving in the wrong direction

The outlier on the downside is Besu. Its median validation time has climbed from 141ms in early February to 171ms today — a 15% deterioration over three weeks.

The p95 picture is worse. Besu's 95th percentile went from around 280ms (Jan 28) to over 700ms (Feb 14), then settled back to ~600ms. If you're a validator running Besu, your EL is taking 4–5× longer than Reth to validate a typical block, and your tail latency is substantial.

For regular attestation on most slots, this still isn't catastrophic — attestations happen at t=4s and Besu usually finishes well before then. But for timing-game blocks that arrive at t≈2–3s, an extra 130ms of EL processing can be the difference between a head vote and a missed one.

## What this means in a slot

At 35ms, Reth processes a full block in 0.3% of a 12-second slot. At 210ms, Erigon is using 1.7% of the slot just on block validation.

Neither is catastrophic in isolation. The timing game research has shown validators don't attest until t≈4s regardless — so a 35ms vs 200ms EL gap isn't directly causing missed attestations most of the time.

Where it matters:

1. **Late arriving blocks** — when a proposer publishes at t=3.5s (timing game), the CL gets the block and calls `engine_newPayload` immediately. An Erigon validator has ~8.5s remaining for that call to complete and attestation to propagate. A Reth validator has ~8.5s but with 170ms less pressure.

2. **Block building** — execution clients also validate their own local builds. Faster validation means fresher block content before the deadline.

3. **Tail risk** — the p95/p99 matters more than the median when you're running thousands of validators. Erigon's p95 at 400–800ms means one in twenty blocks takes a substantial chunk of your attestation window.

The race is happening at the millisecond level. And over the last 30 days, Reth has been running it harder than anyone.

---

*Data: ethpandaops xatu `execution_engine_new_payload` table, mainnet. 30-day window ending Feb 27, 2026. `engine_newPayload` calls with `status = VALID` only. Win-rate data from `xatu-cbt mainnet.fct_engine_new_payload_winrate_daily`. ethrex first observed Jan 29, 2026.*
