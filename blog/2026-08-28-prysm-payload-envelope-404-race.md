---
slug: prysm-payload-envelope-404-race
title: Prysm announced 7,139 payloads. Its API returned 14,284 404s.
description: One Platåberget Prysm node emitted 7,139 execution-payload availability events in a day while its envelope endpoint counted 14,284 HTTP 404s. The payload was ready; the API database was not.
authors: aubury
tags: [ethereum, gloas, prysm, glamsterdam, data]
date: 2026-08-28
---

An event named `execution_payload_available` should be safe to act on. One Prysm node emitted 7,139 of them on August 27 while its payload-envelope endpoint counted 14,284 HTTP 404s: 2.0008 misses for every event.

<!-- truncate -->

<img src="/img/prysm-payload-envelope-404-race.png" alt="Hourly chart for one Prysm node on Platåberget during August 27 UTC. The node emitted about 300 execution-payload availability events per hour while its execution-payload-envelope API returned about 600 HTTP 404 responses per hour. Totals were 7,139 events and 14,284 404s, or 2.0008 404s per event. A pre-fix Prysm image rollout at 12:35 UTC did not change the pattern." loading="eager" />

The two series are not a root-by-root join. They are independent counters from the same named node over the same complete UTC day. Still, the hourly relationship is almost rude in its precision: roughly 300 availability events and 600 not-found responses, hour after hour.

## "Available" was ahead of the database

The public Beacon API definition says `execution_payload_available` means the node has verified that a block's execution payload and blobs are available and ready for a payload-timeliness-committee vote. Another Gloas endpoint, `GET /eth/v1/beacon/execution_payload_envelopes/{block_id}`, returns that envelope by block root. A consumer reacting to the first API surface has a fair reason to expect the second one not to say "not found."

I froze August 27 UTC on Platåberget and kept one observer, `glamsterdam-devnet-8-buildoor-prysm-ethrex-1`. The Xatu event table contained 7,139 rows, 7,139 distinct `(slot, block_root)` pairs, and 7,139 distinct slots. There was no observer-row multiplier hiding in the event count.

```sql
SELECT
  count() AS event_rows,
  uniqExact((slot, block_root)) AS exact_events,
  uniqExact(slot) AS event_slots
FROM `glamsterdam-devnet-8`
  .beacon_api_eth_v1_events_execution_payload_available FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-27 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-28 00:00:00')
  AND meta_client_name =
    'ethpandaops/devnets/glamsterdam-devnet-8-buildoor-prysm-ethrex-1'
```

The physical ceiling was 7,200 scheduled slots. The refined canonical block path returned 7,175 unique slot/root rows over the same bounds, while the busiest Prysm observers emitted 7,151 availability events. This node's 7,139 events fit the chain clock and the surrounding observer cohort.

The API side came from Prysm's own `http_request_count` metric. I evaluated the counter as one 24-hour increase at the end of the window, then repeated it as 24 adjacent one-hour increases for the chart. Both paths returned the same totals.

```promql
sum by (code) (
  increase(
    http_request_count{
      network="glamsterdam-devnet-8",
      consensus_client="prysm",
      instance="glamsterdam-devnet-8-buildoor-prysm-ethrex-1",
      endpoint="beacon.GetExecutionPayloadEnvelope"
    }[24h]
  )
)
```

The result was 14,284 responses with code 404, 244 with code 200, and 33 with code 500. Not-found responses were 98.10% of the 14,561 envelope GETs. More strangely, `14,284 / 7,139 = 2.0008`: two 404s per availability event, plus six.

## Prysm said "now" too early

The code path explains the shape. In the [pre-fix receiver](https://github.com/OffchainLabs/prysm/blob/596e497f642a8f796e086f925634452217682417/beacon-chain/blockchain/receive_execution_payload_envelope.go#L124-L144), Prysm emitted `ExecutionPayloadAvailable`, waited for execution-layer validation, and only then called `savePostPayload`. The [GET handler](https://github.com/OffchainLabs/prysm/blob/596e497f642a8f796e086f925634452217682417/beacon-chain/rpc/eth/beacon/handlers_gloas.go#L29-L58) read the envelope from that database and returned 404 when the row was absent.

That ordering left a tiny but very real hole. A fast consumer could receive the event, request the same root immediately, and arrive before the write. Prysm [PR #17418](https://github.com/OffchainLabs/prysm/pull/17418) includes the missing root-level proof: a proxy trace saw the SSE event at `11:51:25.078` and a GET for the same root one millisecond later at `11:51:25.079`; the GET returned 404.

The fix moves `savePostPayload` ahead of the event. It does not delay the event until execution-layer validation finishes, because the event's job is to say the payload and blobs are ready for a PTC vote. If later execution validation fails, Prysm deletes the envelope again. The new regression test checks both sides of that contract: the row exists when the event fires, and an execution-invalid envelope does not remain behind.

PR #17418 merged on August 27 at 16:36 UTC. The measured node rolled from Prysm commit `81a701c` to `8d02caf` at 12:35 UTC; `8d02caf` was committed earlier that day and predates the fix. The 2-to-1 pattern continued after that rollout, so this is not a before/after fix test. It is the last clean picture of the old ordering.

## A 404 was not an unavailable payload

This distinction matters because an API consumer can turn a storage race into a protocol-looking failure. The PR says Dora fetched on `execution_payload_available`, treated 404 as "no envelope," and showed about 90% of unfinalized slots as unavailable on the affected devnet. The telemetry here measures the underlying request-status shape, not Dora's slot classification.

It is also one node's consumer traffic, not a Prysm fleet failure rate. Other Prysm nodes had very different endpoint counters because they were not receiving the same request pattern. The 98.10% figure is the share of envelope GET responses on this node, not the share of missing payloads, failed PTC votes, or broken Gloas slots.

Gloas is still pre-release devnet software, and this was not a Mainnet incident. The interesting bit is narrower: an event and a read endpoint briefly disagreed about whether the same object existed. The payload was ready. The database was a few milliseconds behind.
