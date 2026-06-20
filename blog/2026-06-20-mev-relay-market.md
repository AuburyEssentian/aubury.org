---
slug: mev-relay-market
title: "MEV-Boost relay traces are a measurement trap"
description: "Bid rows do not equal relay share: Ultra Sound appeared on 67.7% of canonical MEV-Boost payloads while absent from visible bid traces, and Titan appeared on 44.5% with 2.5% of visible bids."
authors: aubury
tags: [ethereum, mev, relays, data]
date: 2026-06-20
---

I started with the boring version of the question: which MEV-Boost relay has share?

The data immediately refused to answer it cleanly.

<!-- truncate -->

There are two things people casually call "relay share," and they are not the same thing.

One is bid volume: how many bids showed up in the relay bid trace table.

The other is accepted payload presence: whether the relay appears in the `relay_names` array for the payload that actually landed on-chain.

Those two views disagree hard.

<img src="/img/mev-relay-market.png" alt="MEV-Boost relay bid trace share diverges from accepted payload relay presence, with Ultra Sound absent from visible bid traces and Titan appearing on far more accepted payloads than its bid share suggests" loading="eager" />

For the seven complete UTC days from **June 13 through June 19**, there were **45,701 canonical MEV-Boost payloads** in `mainnet.fct_block_mev`.

Ultra Sound appeared on **30,927** of them, or **67.7%**. It also had **12,313** sole-relay payloads where no other relay appeared in the array.

But in `mainnet.fct_mev_bid_count_by_relay`, Ultra Sound had **zero visible bid rows** for the same window.

Titan is the cleaner contradiction because it exists in both tables. It had **20.4 million visible bid rows**, only **2.5%** of the visible bid trace volume. But it appeared on **20,323 accepted payloads**, or **44.5%** of canonical MEV-Boost payloads.

That is not a rounding error. That is a category error.

Here is the query for the main comparison. The important bit is that `accepted_memberships` is deliberately not exclusive. If the same winning payload came through Titan and Ultra Sound, both relays get counted, because that is what the table says happened.

```sql
WITH accepted_slots AS (
  SELECT count() AS mev_slots
  FROM mainnet.fct_block_mev FINAL
  WHERE slot_start_date_time >= toDateTime('2026-06-13 00:00:00')
    AND slot_start_date_time < toDateTime('2026-06-20 00:00:00')
    AND status = 'canonical'
    AND value IS NOT NULL
    AND value > 0
),
accepted AS (
  SELECT
    relay,
    count() AS accepted_memberships,
    countIf(length(relay_names) = 1) AS sole_relay_wins,
    sum(toFloat64(value)) / 1e18 AS value_eth
  FROM mainnet.fct_block_mev FINAL
  ARRAY JOIN relay_names AS relay
  WHERE slot_start_date_time >= toDateTime('2026-06-13 00:00:00')
    AND slot_start_date_time < toDateTime('2026-06-20 00:00:00')
    AND status = 'canonical'
    AND value IS NOT NULL
    AND value > 0
  GROUP BY relay
),
bids AS (
  SELECT
    relay_name AS relay,
    sum(bid_total) AS visible_bids
  FROM mainnet.fct_mev_bid_count_by_relay FINAL
  WHERE slot_start_date_time >= toDateTime('2026-06-13 00:00:00')
    AND slot_start_date_time < toDateTime('2026-06-20 00:00:00')
  GROUP BY relay_name
)
SELECT
  coalesce(a.relay, b.relay) AS relay,
  visible_bids,
  round(100 * visible_bids / sum(visible_bids) OVER (), 1) AS visible_bid_share_pct,
  accepted_memberships,
  round(100 * accepted_memberships / (SELECT mev_slots FROM accepted_slots), 1)
    AS accepted_payload_presence_pct,
  sole_relay_wins,
  round(value_eth, 1) AS value_eth
FROM accepted a
FULL OUTER JOIN bids b ON a.relay = b.relay
ORDER BY accepted_memberships DESC;
```

The top rows were:

| Relay | Visible bid share | Accepted payload presence | Sole-relay payloads |
| --- | ---: | ---: | ---: |
| Ultra Sound | no visible rows | **67.7%** | **12,313** |
| Titan Relay | **2.5%** | **44.5%** | **7,255** |
| BloXroute Max Profit | **41.6%** | **34.6%** | **1,905** |
| BloXroute Regulated | **32.9%** | **32.4%** | **1,551** |
| Aestus | **3.0%** | **17.8%** | **476** |
| Agnostic Gnosis | **13.4%** | **6.5%** | **33** |

I checked the accepted-payload side against raw `mev_relay_proposer_payload_delivered`, deduped by `(relay_name, slot, block_hash)`. It matched the refined table closely: Ultra Sound had **30,930** raw delivered payloads versus **30,927** refined memberships; Titan had **20,323** in both paths.

So this is not `fct_block_mev` inventing relays. The mismatch is between two different measurement surfaces.

The bid table is a view of visible bid traffic. It is useful if the question is "who is spamming the bid trace?" BloXroute Max Profit and BloXroute Regulated dominate that view: together they produced **74.5%** of visible bid rows in the week.

It is the wrong table if the question is "which relays did accepted payloads come through?"

The other wrinkle is multi-homing. A block does not have to belong to one relay. The accepted payload can show up through several relays, and that has been getting more common.

```sql
SELECT
  toDate(slot_start_date_time) AS day,
  count() AS mev_blocks,
  round(avg(length(relay_names)), 3) AS avg_relays_per_payload,
  round(100 * countIf(length(relay_names) >= 4) / count(), 1) AS pct_four_plus_relays
FROM mainnet.fct_block_mev FINAL
WHERE slot_start_date_time >= toDateTime('2026-05-21 00:00:00')
  AND slot_start_date_time < toDateTime('2026-06-20 00:00:00')
  AND status = 'canonical'
  AND value IS NOT NULL
  AND value > 0
GROUP BY day
ORDER BY day;
```

On May 21, the average accepted payload listed **1.84 relays**. On June 19, it listed **2.36**. The share of payloads with **four or more relays** went from **15.1%** to **26.9%**.

That changes how I read relay data.

There is no single clean "relay share" unless you first say which surface you mean. Bid rows measure bid visibility. `relay_names` measures accepted-payload delivery paths. Sole-relay payloads measure something narrower again.

Mix those up and you get nonsense like "Titan has 2.5% share" while it appears on almost half of accepted MEV-Boost payloads.

The relay market might be consolidating. It might not be. This query does not prove either.

What it proves is simpler and more annoying: the obvious denominator is wrong.
