---
slug: one-in-four-attestations-is-late
title: One in four attestations is late
authors: aubury
tags: [attestations, consensus, ethereum, validator]
date: 2026-02-22
---

Analyzing 24 hours of mainnet data: 72.5% of attestations are included in the next slot (optimal), but 27.5% are delayed. These delayed attestations earn reduced rewards.

## How Attestations Work

Every 12 seconds, validators attest to the beacon chain state. The ideal inclusion delay is **1 slot** — your attestation in the very next block. This maximizes rewards.

Delays happen when:
- The next proposer misses their slot
- Network propagation is slow
- Temporary forks occur

## The Numbers

| Delay | Count (24h) | Percentage | Reward |
|-------|-------------|------------|--------|
| 1 slot | 567,914 | 72.5% | 100% |
| 2 slots | 128,569 | 16.4% | ~85% |
| 3+ slots | 86,544 | 11.1% | ~60-70% |

Average inclusion delay: **1.65 slots**

## The Cost

Ethereum's attestation rewards decay with delay. An attestation in slot *N+1* earns full rewards. By slot *N+2*, ~85%. By slot *N+3*, ~70%.

Back-of-the-envelope: ~215,000 attestations per day are delayed beyond 1 slot. If each would have earned 0.00003 ETH at optimal inclusion, and delayed ones earn ~20% less on average, that's roughly **1.3 ETH per day** left on the table. About **475 ETH per year**.

## Why This Happens

The 27.5% delay rate breaks down into:
- **16.4%** are 2-slot delays — mostly from missed blocks (~1% missed block rate on mainnet)
- **11.1%** are 3+ slot delays — network issues, forks, or client problems

## Query

```sql
SELECT 
    count() as total,
    avg(inclusion_delay) as avg_delay,
    countIf(inclusion_delay = 1) as next_slot,
    countIf(inclusion_delay = 2) as two_slots,
    countIf(inclusion_delay > 2) as delayed
FROM (
    SELECT block_slot - slot as inclusion_delay
    FROM canonical_beacon_elaborated_attestation
    WHERE meta_network_name = 'mainnet'
      AND slot_start_date_time >= now() - INTERVAL 24 HOUR
)
```

## What This Means

Validators can't control whether the next proposer misses their slot. You can run perfect hardware and still get delayed. It's a collective action problem: everyone benefits from a healthy network, but no individual validator can improve it directly.

The takeaway: **at least 27% of attestations are suboptimal through no fault of the validator.** The network works, but there's room for improvement in propagation and reliability.
