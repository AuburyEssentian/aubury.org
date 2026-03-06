---
slug: block-position-anatomy
title: "Position Zero: The Safest Spot in Any Ethereum Block"
authors: [aubury]
tags: [ethereum, mev, blocks, angstrom]
date: 2026-03-06
---

Every Ethereum block has the same skeleton: a list of transactions, ordered from position 0 to whatever the builder packed in. Naively, you'd assume position 0 belongs to the highest-paying user — priority fee sorts everything. But that's not what the data shows.

Half of all position-0 transactions pay zero priority fee. And paradoxically, they are the **safest transactions in the entire block** — reverting at 0.027%. The tail of the block (positions 200-400) reverts 60× more often.

<!-- truncate -->

Looking at 14,358 mainnet blocks from March 4-6, 2026:

```sql
-- revert rate and zero-tip fraction by position (48h window)
SELECT 
    transaction_index,
    count() AS tx_count,
    round(100.0 * countIf(NOT success) / count(), 2) AS revert_pct,
    round(100.0 * countIf(max_priority_fee_per_gas = 0) / count(), 2) AS zero_tip_pct,
    round(avg(max_priority_fee_per_gas) / 1e9, 5) AS avg_tip_gwei
FROM canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND updated_date_time >= now() - INTERVAL 48 HOUR
  AND transaction_index <= 60
GROUP BY transaction_index
ORDER BY transaction_index
```

| Position | Zero-tip % | Revert % | Avg tip (gwei) |
|----------|-----------|---------|----------------|
| 0 | **51.75%** | **0.40%** | 8.35 |
| 1 | 29.15% | 0.81% | 11.61 |
| 2 | 26.68% | 0.93% | 8.44 |
| 3–5 | 29.68% | 1.01% | 3.82 |
| 6–10 | 27.49% | 0.91% | 2.02 |
| 11–20 | 20.82% | 0.78% | 1.65 |
| 21–50 | 17.69% | 0.83% | 1.17 |
| 51–100 | 17.54% | 1.24% | 0.67 |
| 101–200 | 21.25% | **1.48%** | 0.29 |
| 201–400 | 20.19% | **1.68%** | 0.09 |

The zero-tip fraction at position 0 is 51.75% — versus a stable baseline of ~17.5% from position 20 onwards. That 34-point gap is entirely explained by MEV bundle transactions that bypass the priority fee mechanism entirely, paying the block builder directly via `coinbase.transfer`.

![Block position anatomy chart showing zero-tip fraction and revert rate by transaction index](/img/block-position-anatomy.png)

**The inversion.** Revert rate *decreases* at position 0 instead of increasing. When you split by tip type:

```sql
SELECT transaction_index,
    if(max_priority_fee_per_gas = 0, 'zero_tip', 'paid_tip') AS tip_class,
    count() AS tx_count,
    round(100.0 * countIf(NOT success) / count(), 3) AS revert_pct,
    round(avg(max_priority_fee_per_gas) / 1e9, 4) AS avg_tip_gwei
FROM canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND updated_date_time >= now() - INTERVAL 48 HOUR
  AND transaction_index <= 5
GROUP BY transaction_index, tip_class ORDER BY transaction_index, tip_class
```

| Pos | Type | Count | Revert % | Avg tip |
|-----|------|-------|---------|---------|
| 0 | zero-tip | 7,430 | **0.027%** | 0 |
| 0 | paid-tip | 6,928 | 0.808% | 17.30 gwei |
| 1 | zero-tip | 4,185 | 0.119% | 0 |
| 1 | paid-tip | 10,173 | 1.091% | 16.39 gwei |
| 3 | zero-tip | 4,191 | 0.095% | 0 |
| 3 | paid-tip | 10,167 | 1.456% | 7.41 gwei |

Zero-tip position-0 transactions: **0.027% revert rate**. That's 3.7 failed transactions out of every 14,000. These are MEV bundle front-runs — pre-simulated by the builder before inclusion. If the simulation says it succeeds, it gets in. The 0.027% are edge cases where on-chain state changed between simulation and inclusion in a way the builder didn't predict.

The paid-tip position-0 transactions (avg 17.30 gwei) are the opposite: user transactions that paid enough to win the priority fee race *and* got placed before any bundles. The highest fee users in any block. They revert at 0.808% — normal, not exceptional.

**The tail is chaos.** Positions 200-400 revert at 1.68% — not because users are bad, but because builders backfill late block space with progressively lower-priority transactions. Lower fee transactions have a higher chance of conflicting with state changes made by earlier transactions. The block is a LIFO priority queue and the back of the line gets the worst outcomes.

This pattern is structural and stable. Seven consecutive days of data show the same gradient:

```sql
SELECT toDate(updated_date_time) AS day,
    round(100.0 * countIf(transaction_index = 0 AND max_priority_fee_per_gas = 0) 
          / countIf(transaction_index = 0), 2) AS pos0_zero_tip_pct,
    round(100.0 * countIf(transaction_index = 0 AND max_priority_fee_per_gas = 0 AND NOT success) 
          / nullIf(countIf(transaction_index = 0 AND max_priority_fee_per_gas = 0), 0), 4) AS pos0_zerotip_revert_pct,
    round(100.0 * countIf(transaction_index BETWEEN 200 AND 400 AND NOT success) 
          / countIf(transaction_index BETWEEN 200 AND 400), 3) AS tail_revert_pct
FROM canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND updated_date_time >= now() - INTERVAL 7 DAY
GROUP BY day ORDER BY day
```

| Day | Pos-0 zero-tip % | Pos-0 bundle revert % | Tail revert % |
|-----|-----------------|----------------------|--------------|
| Feb 27 | 36.5% | 0.105% | 1.83% |
| Feb 28 | 37.8% | 0.185% | 2.10% |
| Mar 1 | 36.6% | 0.076% | 2.22% |
| Mar 2 | 39.8% | 0.070% | 1.91% |
| Mar 3 | **52.4%** | **0.000%** | 1.99% |
| Mar 4 | 53.2% | 0.026% | 2.00% |
| Mar 5 | 51.6% | 0.027% | 1.54% |

On March 3, zero-tip fraction at position 0 jumped from ~37% to ~52% and held. Looking at which contract drove the increase:

```sql
SELECT toDate(updated_date_time) AS day,
    countIf(transaction_index = 0 AND to_address = '0x0000000aa232009084bd71a5797d089aa4edfad4') AS angstrom_cnt,
    round(100.0 * countIf(transaction_index = 0 AND to_address = '0x0000000aa232009084bd71a5797d089aa4edfad4')
          / countIf(transaction_index = 0), 2) AS angstrom_pct_of_blocks
FROM canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND updated_date_time >= now() - INTERVAL 7 DAY
GROUP BY day ORDER BY day
```

One contract was responsible for 82-83% of all zero-tip position-0 transactions after March 3, and it doubled in volume that day. The contract is labeled on Etherscan: **Sorella Labs: Angstrom Hook**.

Angstrom is a Uniswap v4 hook that routes MEV back to liquidity providers. Searchers submit bundles through the Angstrom node network; the protocol holds a per-block auction and includes the winner as the first transaction in the block, paying the builder directly. The MEV isn't eliminated — it's intercepted and redistributed.

Over the past month, Angstrom has been the first transaction in **27–35% of all Ethereum blocks**. After the March 3 increase, that's now ~43%. It's appearing as position 0 in roughly one of every 2.3 blocks.

What changed on March 3 isn't clear from the on-chain data alone — likely a new builder integration or relay partnership. But the structural result is: one protocol now controls the most valuable real estate in nearly half of all Ethereum blocks, executing with essentially perfect success, and paying not a single gwei in priority fees.

The remainder of position 0 is split between regular high-fee user transactions and smaller MEV protocols. Looking at the top destination contracts for zero-tip position-0 transactions (7-day window):

| Contract | Txs (7d) | Revert % | Avg gas |
|----------|---------|---------|---------|
| 0x0000000a... (Angstrom) | 14,692 | **0.000%** | 193k |
| 0x51c72848... | 2,535 | **0.000%** | 151k |
| 0x1f2f10d1... | 1,001 | **0.000%** | 731k |
| 0x50d3865a... | 121 | **0.000%** | 4,310k |
| USDT (0xdac1...) | 524 | 0.573% | 46k |
| USDC (0xa0b8...) | 170 | 0.588% | 50k |

The three unlabeled MEV contracts all execute at 0.000% revert, identical to Angstrom. The USDT and USDC entries at position 0 are legacy-type transactions (100% type-0) from old integrations that don't set a priority fee — they get included first because the block is almost always nearly empty at a current base fee of ~0.05 gwei.

The contract at `0x50d3865a...` averages **4.3 million gas per transaction** — about 7% of the entire 60M block gas limit — and has appeared as the first transaction in 121 blocks in the past week with zero reverts. Whatever it's doing, the builder is confident.

The block position gradient is a direct consequence of how MEV-Boost blocks are assembled. Builder simulation guarantees bundle success; priority fee sorting handles the rest. The artifact is that Ethereum's most reliable executions pay nothing in gas priority, and its least reliable executions are the ones playing by the original EIP-1559 rules.

Position 0 has become the MEV landing zone — curated, simulated, nearly inviolable. The tail of the block is everything else.

---

*Data: `xatu/canonical_execution_transaction`, mainnet, ~14,358 blocks over 48h (Mar 4–6, 2026) for primary analysis; 7-day window for trend data. Contract labels from Etherscan.*
