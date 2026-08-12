---
slug: libp2p-publish-message-before-dedupe
title: "PUBLISH_MESSAGE fires before libp2p decides not to publish"
description: "One mainnet observer emitted 90,481 second PUBLISH_MESSAGE events for content it had already seen. The trace hook runs before libp2p's seen-cache check."
authors: aubury
tags: [ethereum, libp2p, gossipsub, xatu, data]
date: 2026-08-12
---

`PUBLISH_MESSAGE` sounds like proof that a message went onto the wire. It is not. Across 14 complete mainnet days, one observer emitted **90,481 second `PUBLISH_MESSAGE` events** for content IDs it had already tried to publish. Every repeated ID appeared exactly twice.

Those second events record a local publish call before libp2p's seen-cache check rejects it. They are not network retransmissions.

<!-- truncate -->

<figure>
  <a href="/img/libp2p-publish-message-retries.png">
    <img src="/img/libp2p-publish-message-retries.png" alt="Daily share of content IDs with a second local libp2p publish call at one mainnet observer from July 29 through August 11 2026. The 14-day average was 1.02%, with a 2.40% peak on August 7 representing 14,316 second calls." loading="eager" />
  </a>
  <figcaption>The denominator is unique local content IDs at the affected observer, grouped by the date of the first call. The chart does not measure wire sends.</figcaption>
</figure>

## The counter increments too early

The trap is in the event name. I started with `default.libp2p_publish_message`, reduced it to one row per observer, topic and content-derived message ID, then counted IDs with more than one row. The window ends at midnight on August 12, so all 14 days are complete.

```sql
WITH attempts AS (
  SELECT
    meta_client_name,
    topic_fork_digest_value,
    topic_name,
    topic_encoding,
    message_id,
    count() AS copies,
    min(event_date_time) AS first_call,
    max(event_date_time) AS last_call
  FROM default.libp2p_publish_message FINAL
  WHERE meta_network_name = 'mainnet'
    AND event_date_time >= toDateTime('2026-07-29 00:00:00')
    AND event_date_time <  toDateTime('2026-08-12 00:00:00')
  GROUP BY
    meta_client_name,
    topic_fork_digest_value,
    topic_name,
    topic_encoding,
    message_id
)
SELECT
  meta_client_name,
  count() AS unique_content_ids,
  sum(copies) AS publish_event_rows,
  countIf(copies > 1) AS repeated_ids,
  sum(copies - 1) AS second_calls
FROM attempts
GROUP BY meta_client_name
ORDER BY repeated_ids DESC;
```

The table held **10,138,628 rows** and **10,048,147 unique observer-topic-ID keys**. All 90,481 extra rows belonged to the same all-subnets observer, where they affected **1.0186% of 8,882,523 unique IDs**. No key appeared three times. The daily share ranged from 0.30% to 2.40%, with 14,316 second calls on August 7.

The topic split was almost comically lopsided: **90,143 beacon attestations** and **338 aggregate-and-proof messages**. There were no repeated beacon-block IDs. This is an observer-specific capture result, not a rate for Ethereum's validator population or for every gossip node.

The library trace hook explains why the table looks this way. In `go-libp2p-pubsub` v0.15.0, [`ValidateLocal` calls `tracer.PublishMessage(msg)`](https://github.com/libp2p/go-libp2p-pubsub/blob/v0.15.0/validation.go#L238-L251) before the validator checks whether the content ID is already in its seen cache. A few lines later, a failed [`markSeen(id)` emits `DuplicateMessage` and returns `dupeErr`](https://github.com/libp2p/go-libp2p-pubsub/blob/v0.15.0/validation.go#L325-L333). [`Topic.Publish` treats that duplicate error as success and returns before `sendMsgBlocking`](https://github.com/libp2p/go-libp2p-pubsub/blob/v0.15.0/topic.go#L235-L246).

So the sequence is:

1. application calls `Topic.Publish`;
2. tracer emits `PUBLISH_MESSAGE`;
3. seen-cache check finds the content ID;
4. libp2p suppresses the duplicate and returns `nil` to the caller.

The Xatu path preserves that trace event. Its Group A sharder keys `PUBLISH_MESSAGE` on topic and message ID, so repeated calls for the same key face the same sampling decision. That makes the duplicate share internally consistent for captured IDs, but the sampled table is still not a census of all mainnet nodes.

## One attestation, three clocks

I checked an exact ID rather than trusting the aggregate alone. Attestation message `e208d507e62c0f258c6488ae1ccf667249512e67` was first parsed by the affected observer at **14:30:01.393 UTC** on July 30. The same observer then emitted `PUBLISH_MESSAGE` for it at **14:30:23.520** and again at **14:31:11.234**.

Other observers decoded that exact ID as validator 2,178,194 attesting in slot 14,883,148 to block root `0x946de4e54a97d8cbd65663d9e7a6f249790f232b1f16c96d586f23396c94b1f8`. It was real content, already present in the local seen cache before either publish trace. Across the full window, every database row was unique at `(event_date_time, observer, topic, message_id)`, which rules out a simple duplicate-row artifact.

I cannot tell from this public surface which higher-level observer path made the second call. That part would need the exact application code and runtime context. The narrower conclusion is enough: `libp2p_publish_message` counts local publish attempts at a pre-deduplication hook. Treating it as a wire-send table overcounted this observer by 1.02% over the window and by 2.40% on its worst day.
