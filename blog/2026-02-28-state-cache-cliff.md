---
slug: state-cache-cliff
title: "The State Cache Cliff"
authors: [aubury]
tags: [ethereum, execution, performance, gas]
---

Ethereum block execution isn't a fixed-cost operation. For small blocks the state LRU cache handles nearly everything. But push past ~45 Mgas and something breaks: cache misses compound, state reads triple in overhead, and p95 execution latency blows past 100ms for a single block.

Nobody talks about this because mgas/s benchmarks measure throughput — not the hidden cost of cold cache reads. The gas limit doubling from 30M to 60M made this matter.

<!-- truncate -->

## What the data shows

The `execution_block_metrics` table in the [Xatu](https://xatu.ethpandaops.io) dataset captures per-block state access stats from a single Reth monitoring node. For each of the ~50K blocks over the past 7 days, it records EVM execution time, state read time, state hash time, commit time — and crucially, the LRU cache hit rates for accounts, storage slots, and code.

The time breakdown across all blocks:

- **61%** EVM execution (opcodes, precompiles)
- **17%** state reads (fetching from the state trie or disk)
- **13%** state commits (writing dirty pages back)
- **9%** state root hashing

State reads are 17% of total block processing time on average. But that average hides a dramatic non-linearity.

## The cliff

Query: `execution_block_metrics WHERE event_date_time >= now() - INTERVAL 7 DAY AND gas_used > 1e6`, grouped by gas tier:

| Block gas   | Blocks | Avg reads | Cache hit rate | Est. misses | State read time (avg) | State read time (p95) |
|-------------|--------|-----------|----------------|-------------|----------------------|----------------------|
| < 15 Mgas   | 6,554  |       717 |         88.6%  |        82   |  3.3 ms              |  6.2 ms              |
| 15–30 Mgas  | 21,889 |     1,542 |         92.4%  |       118   |  6.8 ms              | 32.6 ms              |
| 30–45 Mgas  | 12,426 |     2,281 |         92.4%  |       174   | 12.0 ms              | 40.1 ms              |
| 45–60 Mgas  |  9,337 |     3,153 |         86.9%  |       414   | 31.5 ms              | 68.9 ms              |

From 30M to 45M gas (+50% more gas):
- State reads grow from 2,281 to 3,153 (+38%)
- Cache misses grow from 174 to 414 (+**138%**)
- State read time grows from 12.0ms to 31.5ms (+**162%**)

Gas grows 50%. Cache misses grow 2.8× faster. State read overhead grows 3× faster.

At the 5M bucket level, the picture is even clearer:

![State cache cliff chart: state read time and cache hit rate vs block gas used](/img/state-cache-cliff.png)

The cache hit rate peaks at 92.7% for 20–30 Mgas blocks, then starts declining as blocks grow larger. By 55 Mgas it's at 84.8% — each block is now spilling state out of the LRU cache, forcing later transactions in the block to re-read from disk what earlier transactions already evicted.

## Why it happens

The Reth execution client maintains LRU caches for recently-accessed accounts, storage slots, and contract code. For smaller blocks (~30M gas), these caches absorb the hot state well — popular DEX contracts, stablecoin balances, and frequently-accessed storage slots stay warm across transactions.

At ~45M+ gas, blocks access enough *unique* storage slots to start exhausting the cache. Earlier transactions in the block warm up slots that later transactions in the same block evict to make room for new ones. Each eviction cascades: the evicted slot might be accessed again by a transaction near the end of the block, now cold.

The estimated cache miss count (reads × (1 − hit_rate)) per 5M bucket:

| Block gas | Est. cache misses | Change vs previous |
|-----------|-------------------|-------------------|
| 5 Mgas    | 61                | —                 |
| 30 Mgas   | 155               | +154% for +500% gas |
| 45 Mgas   | 278               | +79% for +50% gas  |
| 55 Mgas   | 501               | +80% for +22% gas  |

From 5M to 55M gas, the miss count grows 10×. Gas grew 11×, which sounds linear — but the cache hit *rate* also collapsed by 5.7 percentage points, meaning each additional 5M of gas at high block density generates disproportionately more cold reads.

## The throughput paradox

Despite the cache miss explosion, raw throughput (mgas/s) keeps climbing:

| Gas tier   | Throughput |
|------------|-----------|
| < 15 Mgas  | 337 mgas/s |
| 15–30 Mgas | 416 mgas/s |
| 30–45 Mgas | 451 mgas/s |
| 45–60 Mgas | 473 mgas/s |

Bigger blocks are faster per Mgas in absolute terms, because fixed overheads (RPC round-trips, block header processing) get amortized over more computation. But the state read fraction of that time grows fast: 10.6% for small blocks, 26.0% for 45–60M blocks.

This is the hidden tax. A "full" block at the old 30M limit spent 6.8ms on state reads. A "full" block at 60M spends 31.5ms — **4.6× the state read overhead for 2× the gas**. And at the p95, it's worse: 32.6ms at 30M versus 69ms at 45–60M, with the tail widening dramatically as the cache starts missing.

## Implications

The gas limit went from 30M to 36M (Feb 2025), then 45M (Jul 2025), then 60M (Nov 2025). Each step pushed more blocks into the cache-stressed regime. At 30M, a "full" block was well within the cache's sweet spot — 92% storage hit rate, 6.8ms read time. At 60M, the median full block carries 414 cache misses and 31.5ms of read overhead.

None of this is close to the 12-second slot budget. At a p95 of 68ms for 45–60M blocks, there's plenty of headroom for normal operation. But the tail risk grows with block gas: blocks that incidentally access more unique state — certain MEV patterns, onboarding transactions for new addresses, contract deployments — will hit p99 or p999 latency that doesn't show up in these averages.

The cache miss non-linearity also means gas limit increases don't have uniform effects. Moving from 30M to 45M was 50% more gas but roughly 50% more misses. Moving from 45M to 60M was another 33% more gas but produced 49% more misses. The cost curve is steeper each step up.

---

*Single-node caveat: this data comes from one Reth monitoring node. Other execution clients (Geth, Nethermind, Besu, Erigon) have different cache implementations and sizes, and their miss rates will differ. The qualitative finding — that state read overhead grows super-linearly with block gas — is likely general, but the specific numbers are Reth-specific. Worth investigating across clients.*

*Query source: `execution_block_metrics` · Xatu (ethpandaops) · Feb 20–27, 2026 · ~50K mainnet blocks*
