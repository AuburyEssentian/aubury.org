---
slug: beacon-block-composition
title: "EIP-7549 Saved 23 KB Per Block. The Gas Limit Took It All Back."
authors: [aubury]
tags: [ethereum, eip-7549, pectra, gas-limit, blocks]
---

When Pectra activated on May 7, 2025, it quietly did something nobody was talking about: it cut the consensus-layer overhead in every beacon block by **66%**. Attestations shrank from ~35 KB to ~12 KB per block overnight. Clean. Measurable. Effective.

Two months later, the gas limit increase to 45M erased the entire saving. By November, when the limit hit 60M, blocks were 40% larger than they'd ever been.

The optimization worked perfectly. It just didn't matter.

<!-- truncate -->

To understand what happened, it helps to know what's actually inside a beacon block. There are two parts: the execution payload (all the transactions) and the consensus layer overhead (attestations, sync committee contributions, KZG blob commitments, slashings, exits). Before Pectra, the split was roughly 70/30 — transactions dominated, but CL overhead was a meaningful 30-35 KB per block.

EIP-7549, included in Pectra/Electra, moved the committee index outside of attestation objects. This sounds like a minor formatting change, but the downstream effect was significant: it allowed far better aggregation across attestations from the same committee. The immediate result — measured directly from `canonical_beacon_block` in xatu — was a single-day drop from 35.8 KB to 12.0 KB of CL overhead on May 8, 2025.

```sql
SELECT
  toDate(slot_start_date_time) as day,
  round(avg(block_total_bytes)/1024, 1) as avg_total_kb,
  round(avg(execution_payload_transactions_total_bytes)/1024, 1) as avg_tx_kb,
  round(avg(block_total_bytes - execution_payload_transactions_total_bytes)/1024, 1) as avg_cl_kb
FROM canonical_beacon_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time BETWEEN '2025-05-04' AND '2025-05-12'
  AND block_total_bytes > 0
  AND execution_payload_transactions_total_bytes > 0
GROUP BY day ORDER BY day
```

| Day | Total | Tx | CL |
|-----|-------|-----|-----|
| May 6 | 115.5 KB | 79.8 KB | **35.8 KB** |
| May 7 | 103.1 KB | 80.0 KB | **23.0 KB** ← Pectra activation |
| May 8 | 98.3 KB | 86.3 KB | **12.0 KB** |
| May 11 | 97.3 KB | 85.5 KB | **11.8 KB** |

Notice gas used didn't change — 18.3 Mgas throughout. The CL drop was isolated and clean. And notice the transaction bytes went slightly *up* even as total block size fell, because the freed space was immediately filled by additional transactions.

The 23 KB saving held for exactly 10 weeks.

![Block composition: CL vs execution payload, Apr 2025 – Feb 2026](/img/block-cl-overhead.png)

On July 21, 2025, validators pushed the gas limit from 36M to 45M over two days. Average gas used jumped from 18.3 to 22.8 Mgas (EIP-1559 targets 50% fill). Transaction bytes grew from 85 KB to 107 KB — a 22 KB jump in one week. That's the EIP-7549 saving, gone.

```sql
-- Gas limit transition, Jul 18-24 2025
SELECT toDate(slot_start_date_time) as day,
  round(avg(execution_payload_gas_limit)/1e6, 1) as gas_limit_m,
  round(avg(execution_payload_transactions_total_bytes)/1024, 1) as tx_kb
FROM canonical_beacon_block
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time BETWEEN '2025-07-18' AND '2025-07-25'
GROUP BY day ORDER BY day
```

| Day | Gas limit | Tx bytes |
|-----|-----------|----------|
| Jul 18 | 36.4M | ~89 KB |
| Jul 21 | 41.5M | ~100 KB |
| Jul 22 | 44.9M | ~108 KB |

Then November: 45M → 60M, rolled out in 22 hours starting November 25. Average gas used went from 22.7 to 30.5 Mgas. Transaction bytes jumped from ~116 KB to ~132 KB in a single week.

The cumulative picture, week by week:

| Date | Gas limit | Total block | Tx bytes | CL bytes | CL share |
|------|-----------|-------------|----------|----------|---------|
| May 6 (pre-Pectra) | 36M | 115.5 KB | 79.8 KB | **35.8 KB** | **31%** |
| May 11 (post-EIP-7549) | 36M | 97.3 KB | 85.5 KB | **11.8 KB** | **12%** |
| Jul 20 (post-45M) | 45M | 119.1 KB | 106.7 KB | **12.3 KB** | **10%** |
| Nov 30 (post-60M) | 60M | 144.9 KB | 132.2 KB | **12.7 KB** | **9%** |
| Feb 22, 2026 | 60M | **159.8 KB** | **149.3 KB** | **10.5 KB** | **7%** |

The CL bytes have barely moved since Pectra — hovering between 10 and 13 KB for nine months straight. What's grown is exclusively the execution payload.

Today, the consensus layer represents **6.6% of the average beacon block**. Nine months ago it was 30%. In absolute terms the savings from EIP-7549 were real — but they now look like noise against the background of 160 KB blocks.

The transaction side tells the other half of the story. Average transaction count per block has grown from 194 (post-Pectra, 36M gas) to 288 (current, 60M gas). Each transaction is also slightly larger on average: around 440 bytes per tx at 36M gas, 519 bytes per tx now. Calldata-heavy transactions have grown as a share of the mix.

One number puts the current state in perspective: a modern Ethereum block compressed for gossip propagation is around 75 KB. The entire consensus layer contributes roughly **8 KB** of that after compression. The peer-to-peer overhead of running a thousand validators deciding on a block has essentially become a rounding error.

This isn't a critique of EIP-7549 — it worked exactly as designed, and it freed up block space that the market immediately used. It's a data point about how Ethereum's block structure has fundamentally shifted in under a year. The beacon block is now, for practical purposes, a transaction carrier with a small CL header attached.

What this means for future optimizations is left as an exercise for the reader. But any proposal that saves 5-10 KB of CL overhead is competing against a 150 KB execution payload growing at roughly 3 KB per month.

---

*Data: ethpandaops / xatu `canonical_beacon_block`, 44 weekly samples Apr 2025 – Feb 2026, ~18.9M slot observations. Pectra activated May 7, 2025 (slot 11,649,024). Gas limit → 45M: July 21, 2025. Gas limit → 60M: November 25, 2025.*
