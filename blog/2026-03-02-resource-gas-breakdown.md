---
slug: resource-gas-breakdown
title: "Ethereum's Hidden Gas Budgets: 38% Goes to Permanent Storage"
authors: [aubury]
tags: [ethereum, gas, evm, research, data]
---

There's a simulation running on every mainnet block that almost nobody talks about. EthPandaOps built it. It watches every EVM opcode across every transaction and asks a question the current gas price deliberately ignores: *what kind of resource is this gas actually paying for?*

The answer changes everything about how you think about gas pricing.

<!-- truncate -->

Ethereum's gas market is unified. One price, one unit. You pay the same gwei per gas whether your transaction is doing arithmetic, reading cold storage, writing new slots, or emitting events. EIP-1559 fine-tuned the pricing mechanism without touching the underlying model — one dimension, one price.

The resource gas decomposition breaks that assumption. Every gas unit gets classified into one of six buckets:

- **Compute** — pure EVM execution (JUMP, PUSH, ADD, CALL base cost)
- **Address Access** — the EIP-2929 cold read penalty (the 2,100 gas you pay to prove you need something)
- **State Growth** — creating new storage (SSTORE to a fresh slot, contract deployment)
- **Log History** — data appended to the block for event indexing
- **Bloom Topics** — topic-based indexing for LOG filters
- **Block Size** — calldata moving through the network

Combined across 12.8 million transactions over the week of Feb 19–27:

```sql
-- xatu-cbt, mainnet.int_transaction_resource_gas
SELECT
    round(sum(gas_compute) * 100.0 / sum(gas_compute + gas_memory + gas_address_access + 
              gas_state_growth + gas_history + gas_bloom_topics + gas_block_size), 2) as pct_compute,
    round(sum(gas_address_access) * 100.0 / ..., 2) as pct_access,
    round(sum(gas_state_growth) * 100.0 / ..., 2) as pct_growth,
    round(sum(gas_history + gas_bloom_topics) * 100.0 / ..., 2) as pct_logging
FROM int_transaction_resource_gas
WHERE meta_network_name = 'mainnet' AND block_number >= 24496000
```

**Compute: 31.6%. State Growth: 27.4%. Address Access: 22.7%. Log History: 11.1%. Block Size: 6.8%.**

![Ethereum's gas budget decomposition](/img/resource-gas-breakdown.png)

That last number is the one that should bother you. State growth and log history — **38.6% of all gas** — are permanent. Every new storage slot written and every LOG emitted gets stored on every full node that ever syncs the chain. They're not one-time CPU costs that you pay once and forget. They're an obligation that accumulates forever.

Compute gas? Transient. Your EVM runs the opcodes, the block is validated, done. Access gas? Transient — the disk read happens, the block moves on. But state growth is structural. Every SSTORE to a new zero slot creates another entry in Ethereum's state trie, indefinitely, for every node that follows.

---

At the opcode level, the specialization is almost total:

```sql
-- int_transaction_call_frame_opcode_resource_gas, 7d window
SELECT opcode, 
    round(sum(gas)/1e9, 1) as total_ggas,
    round(sum(gas_compute)/1e9, 1) as compute_ggas,
    round(sum(gas_address_access)/1e9, 1) as access_ggas,
    round(sum(gas_state_growth)/1e9, 1) as growth_ggas,
    round(sum(gas_history + gas_bloom_topics)/1e9, 1) as logging_ggas
FROM int_transaction_call_frame_opcode_resource_gas
WHERE meta_network_name = 'mainnet'
GROUP BY opcode ORDER BY total_ggas DESC LIMIT 10
```

**SSTORE** consumed 422.4 billion gas in seven days. Of that, **402 Ggas (95%) went to state growth**. Only 8.4 Ggas was compute — the actual cost of the opcode logic. Almost everything you pay for SSTORE is paying for the permanent storage obligation.

**SLOAD** consumed 259.5 Ggas. **230.6 Ggas (89%) went to address access** — the EIP-2929 cold read tax. The actual computation of fetching a value is a rounding error. You're mostly paying a toll that says "I haven't accessed this slot yet in this transaction."

**LOG3** consumed 56.7 Ggas. **98% went to history and bloom topics** — paying for the event data that gets written into the block forever.

**CALL**: 87.7% compute, 17.4% access. The base call cost and forwarded execution are compute; touching a cold address triggers the access penalty.

Everything else — JUMP, PUSH, DUP, ADD, SWAP — lands 100% in compute. The pure algorithmic work that the EVM was designed for.

---

This matters when you zoom to the transaction level. An ERC-20 transfer (64K gas on average, n=860K transactions sampled) decomposes as:

```sql
-- avg gas breakdown for ERC-20 transfers in the 60k-70k gas range
-- from int_transaction_resource_gas WHERE block_number >= 24500000
-- AND total resource gas BETWEEN 60000 AND 70000
compute: 13,176  (20.7%)
access:  14,867  (23.3%)
growth:  20,763  (32.6%)    ← bigger than compute
logging:  8,552  (13.4%)
blocksize: 6,316   (9.9%)
```

A third of the cost of every ERC-20 transfer is state growth. Why? Because if the recipient has never held this token before, the mapping slot for their balance is new — a fresh storage slot that wasn't there before. That slot now exists permanently.

Under unified gas pricing, the sender paying 64K gas × 0.05 gwei base fee is paying the exact same market rate as a ZK proof verifier spending the same gas on pure arithmetic. The compute-heavy transaction is subsidizing the state-growing one.

---

The cross-subsidy works in both directions depending on where base fees sit. When the network is congested (high base fees), everyone pays more — but the transactions that create the least permanent burden (pure compute) pay the same rate as those that create the most (state growth). When the network is quiet (0.05 gwei base fees like now), the same mix is just priced cheaply across the board.

What a multi-resource gas model would change: compute gets its own price calibrated to CPU cost (transient, cheap), state growth gets its own price calibrated to storage permanence (expensive, tied to how long state must be kept), and log history gets priced for the block bandwidth and archival cost it represents. Under that model, a ZK verifier loop would cost a fraction of its current gas. A mass token airdrop writing 50,000 new balance slots would cost far more.

The EthPandaOps decomposition is the accounting infrastructure that makes that analysis possible. It's running live on mainnet, verified against actual block gas used (resource_net ≈ actual_gas_used within 0.5%), and the data is there when Ethereum's gas reform discussion gets specific enough to need it.

The unified gas model has served Ethereum for years. But it's increasingly hiding the real cost structure underneath a single number. 38.6% of what users pay is for a different category of resource than the other 61.4% — and the current market doesn't distinguish between them.

---

**Data sources:** `mainnet.int_transaction_resource_gas`, `mainnet.int_block_resource_gas`, `mainnet.int_transaction_call_frame_opcode_resource_gas` — all from the [EthPandaOps xatu-cbt cluster](https://github.com/ethpandaops/xatu). Block window: 24,496,000–24,546,241 (Feb 19–27, 2026). Sample: 12.8M transactions, 50,246 blocks. Resource totals verified against `canonical_beacon_block.execution_payload_gas_used` (within 0.5%).
