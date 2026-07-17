---
slug: getblobs-null-status-correction
title: "The UNSUPPORTED blob response was a label, not a response"
description: "The same engine_getBlobsV2 calls were stored as EMPTY on one side of Xatu and UNSUPPORTED on the other. Neither label identifies the actual cause of a null result."
authors: aubury
tags: [ethereum, blobs, engine-api, data, correction]
date: 2026-07-17
---

I called hundreds of thousands of `engine_getBlobsV2` rows proof that some execution-client builds did not support the method. That was too clean. `UNSUPPORTED` was a label added by the collector, not a status returned by the execution client.

This corrects both [The Blob Blindspot](/blog/nethermind-blob-blindspot/) and [engine_getBlobsV2 is still fragmented](/blog/getblobs-v2-fragmentation/). The counts in those posts were real counts of rows carrying that label. The interpretation was wrong.

<!-- truncate -->

The bad query was ordinary enough:

```sql
SELECT
  meta_execution_implementation AS client,
  meta_execution_version AS version,
  count() AS calls,
  countIf(status = 'SUCCESS') AS success_calls,
  countIf(status = 'UNSUPPORTED') AS unsupported_calls
FROM mainnet.int_engine_get_blobs FINAL
WHERE slot_start_date_time >= now() - INTERVAL 14 DAY
  AND node_class = ''
  AND method_version = 'V2'
GROUP BY client, version;
```

That query measures the stored status column correctly. I then let the word `UNSUPPORTED` supply the mechanism: old client, missing method, upgrade needed. The table never proved any of that.

The clue was sitting in a second raw capture. Xatu stores the call from the consensus side in `consensus_engine_api_get_blobs`, while the RPC snooper stores the same CL-to-EL exchange in `execution_engine_get_blobs`. Over the fixed 14-day window from July 3 03:30 to July 17 03:30 UTC, the consensus table had **78,321 unique `EMPTY` observations**.

I fetched the two distributed tables separately rather than trusting one large raw join:

```sql
-- Consensus-side rows
SELECT
  meta_client_name,
  meta_execution_implementation,
  event_date_time,
  requested_date_time,
  versioned_hashes,
  requested_count,
  returned_count,
  status
FROM default.consensus_engine_api_get_blobs FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-03 03:30:00')
  AND event_date_time <  toDateTime('2026-07-17 03:30:00')
  AND status = 'EMPTY';
```

```sql
-- Execution-side snooper rows
SELECT
  meta_client_name,
  meta_execution_implementation,
  event_date_time,
  requested_date_time,
  versioned_hashes,
  requested_count,
  returned_count,
  status
FROM default.execution_engine_get_blobs FINAL
WHERE meta_network_name = 'mainnet'
  AND event_date_time >= toDateTime('2026-07-03 03:30:00') - INTERVAL 2 SECOND
  AND event_date_time <  toDateTime('2026-07-17 03:30:00') + INTERVAL 2 SECOND
  AND source = 'ENGINE_SOURCE_SNOOPER'
  AND status = 'UNSUPPORTED';
```

The local match used the observer, exact versioned-hash list and request count, then took the nearest request timestamp within one second. This keeps the source clocks separate while making the request payload do most of the matching work.

```python
consensus["hash_key"] = consensus.versioned_hashes.map(tuple)
snooper["hash_key"] = snooper.versioned_hashes.map(tuple)

matched = pd.merge_asof(
    consensus.sort_values("requested_date_time"),
    snooper.sort_values("requested_date_time"),
    on="requested_date_time",
    by=["meta_client_name", "hash_key", "requested_count"],
    direction="nearest",
    tolerance=pd.Timedelta("1s"),
)
```

**78,318 of the 78,321 consensus-side `EMPTY` rows matched a snooper observation. Every matched snooper row was labelled `UNSUPPORTED`, and every pair agreed that zero blobs were returned.** The mapping appeared across Besu, Erigon, ethrex, go-ethereum, Nethermind and Reth. Only three `EMPTY` rows lacked a snooper counterpart inside the one-second gate.

<a href="/img/getblobs-null-status-correction.png"><img src="/img/getblobs-null-status-correction.png" alt="The same 78,318 engine_getBlobsV2 calls are labelled EMPTY in the consensus-side capture and UNSUPPORTED in the execution-side snooper capture" loading="eager" /></a>

This is not a new July behaviour. I repeated the match inside the old article's data period, using February 24 from 12:00 to 13:00 UTC. All **266** consensus-side `EMPTY` observations matched snooper rows labelled `UNSUPPORTED`, spanning Nethermind, Reth, Erigon, ethrex and go-ethereum.

The collector code explains the split. [`rpc-snooper`](https://github.com/ethpandaops/rpc-snooper/blob/f7365f0ee9070129d406c486802fdcccb44fbbee/xatu/engine_getblobs.go#L194-L245) assigns `ERROR` when the JSON-RPC response contains an error. It assigns `UNSUPPORTED` when the result is `null` or is not an array. The execution client does not send the string `UNSUPPORTED` over the Engine API.

For V2, `null` is a valid and deliberately overloaded result. The [Osaka Engine API specification](https://github.com/ethereum/execution-apis/blob/60dbef739bde0db7ac30b6075439e192bfbd087e/src/engine/osaka.md#engine_getblobsv2) requires it when any requested blob is missing or old, when an old blob has been pruned, or when the execution client is syncing or otherwise unable to serve blob-pool data. A null result tells the caller that the all-or-nothing V2 request did not produce the complete set. It does not tell us which of those causes applied.

That also explains the suspiciously perfect response shape in the June post. V2 is an all-or-nothing method. A successful response contains the complete requested array; a missing member collapses the whole result to `null`. So the finding that successful 19–21-blob calls returned complete sets still holds. The client-support leaderboard does not.

The February post was more wrong. It said `UNSUPPORTED` "specifically means the EL doesn't implement the method at all," blamed one Nethermind version, and treated the rate as an upgrade census. Status alone supports none of those claims. It also attributed `engine_getBlobsV2` to Pectra, while the method is specified in the Osaka execution fork paired with Fulu.

The honest label is ugly: **V2 null-or-non-array result as classified by the snooper**. We cannot split missing blobs from pruning, syncing or general inability without another signal. We definitely cannot turn it into client adoption by sorting a column whose name overpromises its semantics.
