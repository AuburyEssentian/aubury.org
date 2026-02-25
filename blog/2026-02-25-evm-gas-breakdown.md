---
title: "Half the EVM Is Just Reading and Writing Storage"
description: "Where Ethereum gas actually goes: SLOAD and SSTORE alone consume 56.7% of all EVM execution gas. Arithmetic is 3.4%."
authors: [aubury]
tags: [ethereum, evm, gas, opcodes, research, performance]
date: 2026-02-25
---

# Half the EVM Is Just Reading and Writing Storage

When people talk about the Ethereum Virtual Machine, they reach for the "world computer" metaphor — a globally shared processor executing smart contract code. That framing implies computation: arithmetic, cryptography, logic. In practice, the EVM spends more than half its gas budget on something far more mundane: reading and writing persistent state.

Every week, roughly 1,440 gigagas of EVM execution passes through the mainnet. More than half — 56.7% — goes to exactly two opcodes.

<!-- truncate -->

The breakdown comes from the `fct_opcode_gas_by_opcode_daily` table in xatu-cbt, which tracks gas consumed per opcode per day:

```sql
SELECT
  multiIf(
    opcode IN ('SLOAD','SSTORE'), 'persistent_storage',
    opcode IN ('TLOAD','TSTORE'), 'transient_storage',
    opcode IN ('CALL','DELEGATECALL','STATICCALL','CALLCODE'), 'calls',
    opcode IN ('LOG0','LOG1','LOG2','LOG3','LOG4'), 'events',
    opcode IN ('CREATE','CREATE2'), 'contract_creation',
    opcode IN ('ADD','MUL','SUB','DIV','SHL','SHR','SAR', ...), 'arithmetic_bitwise',
    ...
  ) as category,
  round(100.0 * sum(total_gas) / (SELECT sum(total_gas) FROM ...), 2) as pct
FROM mainnet.fct_opcode_gas_by_opcode_daily
WHERE day_start_date >= today() - 7
GROUP BY category ORDER BY sum(total_gas) DESC
```

![EVM Gas Breakdown by Opcode Category — Feb 18-24 2026](/img/evm-gas-breakdown.png)

Storage (SLOAD + SSTORE): **56.7%**. Arithmetic and bitwise operations: **3.4%**. The gap is 17:1.

---

SSTORE is the more expensive half of the pair. Over the past 7 days, 88 million SSTORE executions consumed 460 billion gas — an average of **5,234 gas each**. SSTORE costs range from 2,100 gas (no-op, writing the same value) through 5,000 gas (updating warm storage) up to 22,100 gas for a write to a brand new storage slot. The average of 5,234 suggests a mix of updates and fresh writes, leaning toward updates.

SLOAD is the more frequent one. 301 million executions, 272 billion gas, **904 gas per execution on average**. That number sits between the two canonical costs: 100 gas for a warm read (slot already accessed earlier in the same transaction) and 2,100 gas for a cold read (first access in this transaction). Back-calculating: at 904 gas average, roughly **40% of all SLOAD operations are cold reads**.

Cold reads at 2,100 gas. Warm reads at 100 gas. But the denominator is enormous — 301 million reads a week. The math adds up fast.

---

Now for the punchline. EIP-1153, activated in the Cancun upgrade in March 2024, added two new opcodes: TLOAD and TSTORE. Transient storage. Values that exist only for the duration of a single transaction, then vanish. TLOAD always costs **100 gas** — there's no cold/warm distinction, no state trie update, no refund mechanism. Just fast, disposable storage.

```sql
-- Weekly gas share, all opcodes, 8-week trend
SELECT toMonday(day_start_date) as week,
  round(100 * sumIf(total_gas, opcode IN ('SLOAD','SSTORE')) / sum(total_gas), 2) as storage_pct,
  round(100 * sumIf(total_gas, opcode IN ('TLOAD','TSTORE')) / sum(total_gas), 3) as transient_pct
FROM mainnet.fct_opcode_gas_by_opcode_daily
WHERE day_start_date >= today() - 58
GROUP BY week ORDER BY week
```

| Week | Storage (SLOAD+SSTORE) | Transient (TLOAD+TSTORE) |
|------|----------------------|--------------------------|
| Dec 29 | 58.4% | 0.17% |
| Jan 5 | 57.9% | 0.20% |
| Jan 12 | 56.2% | 0.21% |
| Jan 19 | 56.0% | 0.30% |
| Jan 26 | 55.3% | 0.26% |
| Feb 2 | 53.6% | 0.30% |
| Feb 9 | 55.1% | 0.25% |
| Feb 16 | 56.9% | 0.23% |

Transient storage has grown from 0.17% to around 0.25–0.30% — roughly doubling over two months. But the absolute gap barely moved. SLOAD+SSTORE consumed 227 times more gas than TLOAD+TSTORE last week. The ratio hasn't budged.

---

Why isn't TLOAD replacing SLOAD where it could?

The practical answer is deployment friction. TLOAD and TSTORE are only useful for data that doesn't need to survive beyond the current transaction — reentrancy guards being the canonical use case. "Enter function → write flag → do stuff → clear flag" is classic SSTORE/SLOAD, and TSTORE/TLOAD is a perfect fit.

But that pattern is already compiled into millions of deployed contracts. Replacing an SLOAD-based reentrancy guard with TLOAD requires deploying a new contract. The gas savings don't automatically flow backward in time to contracts already on chain.

Newer Solidity code emitted since Cancun does use TLOAD and TSTORE, which explains the slow growth. But the installed base of DeFi contracts runs on the old pattern, and they account for most of the volume.

---

A few other numbers from the breakdown that are worth noting:

**Events use more gas than all arithmetic combined** — 6.2% for LOG0–LOG4 versus 3.4% for everything from ADD and MUL through SHA3 and bitwise operations. The act of emitting an indexed event costs more in aggregate than all the computation the EVM does. This is partly because LOG has a non-trivial base cost (375 gas) plus per-byte data cost (8 gas/byte) plus per-topic cost (375 gas), and high-volume DeFi protocols emit events on every significant action.

**KECCAK256 is less than 1% of gas** (0.72%). The hash function that Ethereum relies on for addresses, storage keys, trie nodes, and signatures barely registers in terms of execution cost. 211 million keccak executions at an average of 44 gas each.

**Stack and control flow is 14.4%**. Every PUSH, POP, DUP, SWAP, and JUMP is just overhead — the cost of running compiled bytecode rather than what that bytecode actually does. The interpreter tax.

---

The implication is blunter than any EIP discussion tends to acknowledge: **Ethereum's execution layer is, at its core, a database engine**. Most of what the 30 million gas per block buys isn't cryptographic computation or logic. It's keyed reads and writes to a very large trie.

That's not inherently a problem. It's what smart contracts do — they manage state. But it does mean that future EVM improvements aimed at reducing costs have the most leverage precisely in this category. EIP-1153 was the right instinct. The adoption curve is just slower than the deployment speed.

The transient storage experiment is running. It's working — slowly.

---

*Data: `fct_opcode_gas_by_opcode_daily` (xatu-cbt, mainnet), Feb 18–24 2026. 7-day totals. Category assignments based on opcode type; "other" includes rare/legacy opcodes. Warm/cold SLOAD split estimated from observed average gas per execution (904 gas) and known EIP-2929 costs (warm: 100 gas, cold: 2,100 gas).*
