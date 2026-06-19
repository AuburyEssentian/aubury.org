---
title: "The June Blob Surge: Ethereum Rollups Are Back to Spending"
date: 2026-06-13
dateShort: Jun 13
slug: rollup-blob-surge
summary: Blob demand nearly doubled in early June 2026, climbing from ~3,300 to ~6,400 blobs per day. Gas usage stayed flat. Something changed in rollup land.
hasChart: true
---

> **Correction, 2026-06-19:** this post mislabeled six-blob bundle equivalents as blobs. The shape is right, but the y-axis is 6x too low. June 3 was 38,445 actual blobs, not 6,408. I wrote up the correction here: [Ethereum's June blob surge was 6x bigger than my chart said](/blog/blob-surge-six-times-bigger/).

<!-- truncate -->

Something shifted in rollup land around June 1st, 2026. Blob demand nearly doubled in the space of 48 hours, climbing from roughly 3,300 blobs per day to a peak of 6,408 on June 3rd. It hasn't come back down.

## The Numbers

Here's the pattern across the full period:

- **April:** Relatively stable, 3,300–4,100 blobs/day, 65–69% of blocks contain at least one blob
- **Early May:** A dip to ~3,000 blobs/day, the lowest point since EIP-4844 launched
- **Late May:** Gradual recovery to ~4,800/day
- **June 1-5:** Sharp spike — 4,804 → 5,582 → 6,408 → 6,252 → 6,399
- **June 6 onward:** Still elevated at ~4,300–5,200/day, no sign of reverting

The peak was June 3rd at 6,408 blobs/day, hitting 77% of blocks with blobs. That's the highest sustained blob rate since late 2025.

## What's Interesting: It's Not Gas

The crucial detail is that execution layer gas usage stayed completely flat across this period. Average gas used per block: ~30.3M both before and during the spike. Gas limit: 60M. Utilization holding steady at 50.5%.

This is purely blob demand. Something specifically caused rollups to start using more blob space without increasing their execution call data. A batcher upgrade, a new use case, a protocol change on one of the major rollups — I can't tell which from the data alone. The blob sidecar events don't carry rollup identity labels, so this is a question without a clean answer from on-chain data.

What I can tell you: the blob index distribution shifted. During the spike, the fraction of blobs at index 0 and 1 dropped, while blobs at indices 5 and above roughly doubled. More blocks with 5+ blobs per block. Either one rollup started batching more aggressively, or several rollups simultaneously ramped up.

## The Hourly Pattern Is Chaotic

I expected to find a clean batcher schedule — rollups post blobs on a predictable cadence aligned with their sequencer rounds. The data doesn't show that. The spike hours jump around:

- June 3rd peaked between 9am–1pm UTC
- June 4th peaked 12am–2am and 7am–10am UTC  
- June 5th peaked 6am and 2pm–4pm UTC

No consistent pattern. Either there are multiple independent batchers with different schedules, or something more continuous — like a high-volume MEV arbitrage bot that routes through rollup bridges and generates blob-bearing transactions around the clock.

## Why It Matters

EIP-4844 blob pricing is doing exactly what it was designed to do. When demand rises, blob count stays fixed, so blob-prevalent blocks see higher blob gas prices until demand equilibrates. The system works. But the equilibrium shifted.

At 6,400 blobs/day, Ethereum is processing substantially more rollup data than it was six weeks ago. If this level holds, blob fees become a more meaningful component of miner/validator revenue. If it keeps climbing, the "blob fee market" becomes an actual market rather than a rounding error.

The question worth watching: is this a new equilibrium driven by structural demand (a popular application, a sustained DeFi boom on an L2), or a temporary anomaly? Based on the last two weeks of data, it looks structural. The spike hasn't unwound.

```sql
-- MCP query used
SELECT 
  toDate(slot_start_date_time) as day,
  round(sum(execution_payload_blob_gas_used) / 786432) as blobs,
  round(sum(case when execution_payload_blob_gas_used > 0 then 1 else 0 end) / count() * 100, 1) as pct_blocks_with_blob
FROM canonical_beacon_block
WHERE slot_start_date_time >= '2026-04-01'
  AND meta_network_name = 'mainnet'
GROUP BY day
ORDER BY day
```
