---
slug: eip-7709-blockhash-airdrop
title: "One SHIB airdrop made 58% of BLOCKHASH calls"
description: "A verified airdrop contract produced 149,600 BLOCKHASH executions in 374 transactions. Under Draft EIP-7709, 327 of those historical calls reused gas limits too tight for even the all-warm backcast."
authors: aubury
tags: [ethereum, evm, gas, opcodes, eip-7709, shib, panda]
date: 2026-08-17
---

[EIP-7709](https://eips.ethereum.org/EIPS/eip-7709) came back from the dead last week. The proposal would charge `BLOCKHASH` for the storage reads it now represents, which sent me looking for contracts that call it hard enough to care. One SHIB airdrop did: **374 transactions into a single contract produced 149,600 calls**, or 58.4% of every observed `BLOCKHASH` execution in a 14-day trace window.

The gas story is stranger than the count. Each airdrop read the same two ancestors 200 times, so most of the proposed storage charges would be warm. Even the cheapest all-warm backcast still pushes **327 of the 374 historical transactions past their original gas limits before their refund becomes usable**.

<!-- truncate -->

<img src="/img/eip-7709-blockhash-airdrop.png" alt="Across fourteen complete UTC days, one SHIB airdrop contract generated 149,600 of 255,991 refined BLOCKHASH calls. Each airdrop transaction made 400 calls against two repeated ancestor slots. Draft EIP-7709 raises that opcode slice from 8,000 gas to between 48,000 and 52,000 gas; 327 of 374 transactions would run out of gas if replayed with their historical limits." loading="eager" />

## The spike was one airdrop loop

The opcode models are not current. Their processed range ends at block 25,530,978, so I did not dress July data up as an August snapshot. I froze the last 14 complete UTC days inside that boundary: June 30 through July 13, blocks **25,426,767–25,527,154**, covering 100,388 canonical execution blocks.

The source row grain is one aggregate per `(block_number, transaction_hash, call_frame_id, operation)`. `opcode_count` is the number of times that opcode ran inside the frame. This was the first pass:

```sql
SELECT
  ifNull(target_address, '<root>') AS frame_target,
  sum(opcode_count) AS blockhash_calls,
  uniqExact(transaction_hash) AS transactions,
  uniqExact(block_number) AS blocks
FROM default.canonical_execution_transaction_structlog_agg FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25426767 AND 25527154
  AND operation = 'BLOCKHASH'
GROUP BY frame_target
ORDER BY blockhash_calls DESC
```

The raw aggregate returned 256,005 calls in 75,078 transactions. The separate `mainnet.int_transaction_call_frame_opcode_gas` path returned 255,991 calls in 75,073 transactions, a 14-call difference, or 0.0055%. I kept the two totals separate rather than averaging them. The chart uses the refined daily series.

The top frame target was not close. Address [`0x23a0…0e45`](https://etherscan.io/address/0x23a0c2bab99fd2f864f5cd8b2659ec3b05d10e45#code), verified on Etherscan as `TheShibBull`, executed 149,600 calls across 374 transactions and 373 blocks. That exact cohort returned **149,600 on both transformation paths**.

All of it landed on July 6, between 05:20:59 and 19:17:47 UTC. The refined daily total was 153,939 calls, which makes this one contract 97.2% of the day's `BLOCKHASH` traffic. Across the full 14 days it was 58.4%.

## Four hundred calls, two ancestors

The verified source explains the suspiciously round number. `airdrop()` loops over 200 recipients and calls `getRandomAddress(i)` each time:

```solidity
uint256 public constant AIRDROP_ADDRESSES = 200;

for (uint256 i = 0; i < AIRDROP_ADDRESSES; i++) {
    address randomAddress = getRandomAddress(i);
    // transfer SHIB to randomAddress
}

function getRandomAddress(uint256 seed) private view returns (address) {
    uint256 rand = uint256(keccak256(abi.encodePacked(
        block.timestamp,
        blockhash(block.number - 1),
        blockhash(block.number - 2),
        block.prevrandao,
        msg.sender,
        block.gaslimit,
        tx.gasprice,
        seed
    )));
    return address(uint160(uint256(keccak256(abi.encodePacked(rand)))));
}
```

Two `BLOCKHASH` instructions per recipient gives 400 per transaction. The traces are unusually clean here: every one of the 374 frames had `min(opcode_count) = max(opcode_count) = 400`, and all 374 canonical transactions succeeded.

That shape matters more than the raw count. EIP-7709 keeps the existing 20-gas opcode charge, then applies `SLOAD` pricing to in-window ancestor lookups served from the EIP-2935 history contract. Both requested ancestors are in the 256-block window, and they map to two distinct history slots.

Under [EIP-2929](https://eips.ethereum.org/EIPS/eip-2929), a cold storage read costs 2,100 gas and a warm read costs 100. The warmed-key set lasts for the transaction, so this is not 400 cold reads. With no access-list warming, the additional charge is `2 × 2,100 + 398 × 100 = 44,000` gas. If both slots somehow start warm, the floor is `400 × 100 = 40,000` gas.

The current `BLOCKHASH` slice is `400 × 20 = 8,000` gas. Draft EIP-7709 moves it to **48,000–52,000 gas**, a 6.0–6.5× increase. The transaction as a whole is much heavier because it also makes 200 SHIB transfers; the interesting part is where its gas limit sits.

## The refund is the trap

At first glance, none of these historical transactions looks tight. The common cohort used a gas limit of 5,801,774 and finished with receipt gas of 5,744,904, apparently leaving 56,870 gas. An extra 40,000–44,000 should fit.

It does not. Every root frame carried a 19,900-gas refund counter, matching the verified `nonReentrant` guard resetting its lock to the original zero value. [EIP-3529](https://eips.ethereum.org/EIPS/eip-3529) describes that exact 19,900 refund case and applies refunds after the transaction's execution gas has been spent. The refund lowers the receipt bill; it cannot keep a running transaction alive.

I fetched the 374 exact hashes from the opcode cohort, then queried canonical transactions and root frames separately in bounded literal batches. That avoids a distributed join deciding the result:

```python
keys = clickhouse.query("clickhouse-raw", """
SELECT block_number, transaction_hash
FROM default.canonical_execution_transaction_structlog_agg FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25426767 AND 25527154
  AND operation = 'BLOCKHASH'
  AND lower(ifNull(target_address, '')) =
      '0x23a0c2bab99fd2f864f5cd8b2659ec3b05d10e45'
""")

for batch in chunks(keys, 80):
    literal_hashes = ",".join(f"'{h}'" for h in batch.transaction_hash)

    tx_rows = clickhouse.query("clickhouse-raw", f"""
    SELECT block_number, transaction_hash, gas_limit, gas_used, success
    FROM default.canonical_execution_transaction FINAL
    WHERE meta_network_name = 'mainnet'
      AND block_number BETWEEN {batch.block_number.min()}
                           AND {batch.block_number.max()}
      AND transaction_hash IN ({literal_hashes})
    """)

    root_rows = clickhouse.query("clickhouse-refined", f"""
    SELECT block_number, transaction_hash, gas_refund
    FROM mainnet.int_transaction_call_frame FINAL
    WHERE block_number BETWEEN {batch.block_number.min()}
                           AND {batch.block_number.max()}
      AND call_frame_id = 0
      AND transaction_hash IN ({literal_hashes})
    """)
```

For 327 transactions, the pre-refund headroom was `5,801,774 - (5,744,904 + 19,900) = 36,970` gas. The all-warm EIP-7709 floor adds 40,000, already 3,030 too much. With two cold first touches, the shortfall becomes 7,030. The remaining 47 transactions carried wider limits and survive either backcast.

This is a same-limit replay, not a prediction that the contract must break. A sender can raise `gas_limit`, an access list can narrow the range from 52,000 toward 48,000, and EIP-7709 is still a Draft with `FORK_TIMESTAMP = TBD`. The proposal was [revived from Stagnant on August 11](https://github.com/ethereum/EIPs/pull/11587); it is not scheduled for mainnet.

This is the compatibility edge I was looking for. Most transactions in the window called `BLOCKHASH` once. One airdrop called it 400 times, tuned its gas limit around a refund that arrives only after execution, and created nearly the entire daily spike. Average opcode counts completely miss that cliff.
