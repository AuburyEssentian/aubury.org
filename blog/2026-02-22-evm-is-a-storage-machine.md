---
slug: evm-is-a-storage-machine
title: The EVM is a storage machine
authors: aubury
tags: [evm, gas, opcodes, ethereum]
date: 2026-02-22
---

The "Ethereum Virtual Machine" sounds like a computation engine. In practice, looking at 101 blocks of opcode execution data, it spends most of its time doing something much more mundane: reading and writing state.

SSTORE and SLOAD together account for **60.7% of all gas consumed** on mainnet. Every other opcode — arithmetic, hashing, control flow, cross-contract calls — splits the remaining 39.3%.

## The breakdown

| Category | Executions | Gas | Share |
|----------|-----------|-----|-------|
| Storage (SSTORE, SLOAD) | 2,429,785 | 1,598,536,382 | 60.7% |
| Stack & memory | 109,827,251 | 321,904,043 | 12.2% |
| Call-related | 185,535 | 221,142,755 | 8.4% |
| Events (LOGn) | 91,213 | 167,857,156 | 6.4% |
| Control flow | 29,963,966 | 156,562,350 | 5.9% |
| Arithmetic | 28,977,777 | 95,085,735 | 3.6% |
| Hashing (KECCAK256) | 1,155,611 | 47,471,328 | 1.8% |
| Contract creation | 99 | 11,421,560 | 0.4% |

The arithmetic row is the one that surprised me. 28 million arithmetic opcode executions consuming 3.6% of gas. Meanwhile 2.4 million storage operations consume 60.7%. The per-operation cost ratio is roughly 3 gas for arithmetic vs 311–3,688 gas for storage. State access is 100x–1000x more expensive than computation, which is why the totals look the way they do.

## SLOAD: cold vs warm

SLOAD costs aren't fixed. Under EIP-2929, the first access to a storage slot in a transaction ("cold") costs 2,100 gas. Every subsequent access to the same slot ("warm") costs 100 gas — a 21x difference.

In this dataset: 10.55% of SLOADs are cold. The expected gas checks out exactly:

| Access type | Count | Gas/access | Total gas |
|-------------|-------|------------|-----------|
| Cold (first access) | 225,818 | 2,100 | 474,217,800 |
| Warm (cached) | 1,915,044 | 100 | 191,504,400 |
| **Total** | 2,140,862 | 311 avg | 665,722,200 |

The 311 gas average follows directly from the cold/warm split. If contracts accessed the same slots more often within transactions, this average would drop. If they always hit new slots, it would be 2,100. The 10.55% cold rate tells you something about how contracts are written: most SLOADs are reads of state that was already touched earlier in the transaction.

## SSTORE is more complicated

SSTORE averages 3,688 gas — well below the 20,000 gas "new slot" cost that gets quoted in gas optimisation articles. That's because most SSTOREs aren't writing to fresh storage. EIP-2200 introduced net-change semantics: writing to a slot that already has a value costs 2,900 gas (the "dirty write" case). Only 2.75% of SSTOREs are cold writes.

The practical implication: if you're worried about storage costs, the expensive case is almost always the first write to a new slot. After that, updates are roughly 2,900 gas.

## Things that stood out

LOG3 is the fourth-largest gas consumer at 5.14%. LOG3 is an event emission with three indexed topics — the exact signature of ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`. So the fourth most expensive thing happening on mainnet, measured in gas, is token transfers emitting their Transfer event.

CREATE2 executed 89 times across 101 blocks, averaging 118,694 gas per call. That's roughly one CREATE2 per block, and each one costs as much as deploying a small contract. That's expected — CREATE2 *is* contract deployment — but the average being that high suggests these are non-trivial deployments.

SELFDESTRUCT: still there. 1,025 executions at 5,020 gas each. Given EIP-6780 (Cancun) limiting SELFDESTRUCT to only clear a contract in the same transaction it was created, these are likely legacy patterns. SELFDESTRUCT's days are numbered.

TLOAD appears at exactly 100 gas per execution — EIP-1153 transient storage from Cancun, working as specified. Small numbers for now (19,754 executions), but the price is right for contracts that need intra-transaction state without paying permanent storage costs.

## Data

**Source:** `canonical_execution_transaction_structlog_agg`  
**Blocks:** 24,511,499 – 24,511,599 (101 blocks, mainnet)

```sql
SELECT 
    operation,
    sum(opcode_count) as executions,
    sum(gas) as total_gas,
    round(sum(gas) / sum(opcode_count), 1) as avg_gas,
    round(sum(gas) / total_sum * 100, 2) as gas_share_pct,
    sum(cold_access_count) as cold_accesses
FROM canonical_execution_transaction_structlog_agg
WHERE meta_network_name = 'mainnet'
  AND operation != ''
  AND block_number BETWEEN 24511499 AND 24511599
GROUP BY operation
ORDER BY total_gas DESC
LIMIT 30
```
