---
slug: arithmetic-panic-kept-going
title: Ethereum caught the arithmetic panic and kept going
description: Across 14 complete days, 92.4% of transactions containing Solidity arithmetic panics still succeeded. One 1inch Aqua path produced most of them.
authors: aubury
tags: [ethereum, evm, solidity, traces, eip-8219, panda]
date: 2026-08-16
---

Solidity's `Panic(0x11)` looks terminal. On mainnet it often isn't: across 14 complete UTC days, **5,333 of 5,772 transactions** containing an overflow, underflow, or division-by-zero panic still ended green. Every panic happened in an internal child call.

<!-- truncate -->

That is a useful wrinkle for [Draft EIP-8219](https://eips.ethereum.org/EIPS/eip-8219), which proposes four checked-arithmetic opcodes. Its `SAFEADD` benchmark cuts a Solidity checked addition from roughly 79 gas to 5, but the cheap failure path returns empty bytes. Solidity currently returns the 36-byte `Panic(uint256)` payload, and the EIP explicitly calls that payload something the new opcodes trade away.

I wanted to know whether those payloads only appear at the end of doomed transactions. They do not.

## The green receipt

I froze blocks **25,656,293 through 25,756,720**, covering August 1–14. The trace key matters here: one row is one internal frame, not one transaction, so I reduced the raw table before reading the panic code.

```sql
-- Step 1: recover each Panic(uint256) frame once.
SELECT
  block_number,
  transaction_hash,
  internal_index,
  trace_address,
  argMax(ifNull(action_to, ''), updated_date_time) AS action_to_address,
  argMax(ifNull(error, ''), updated_date_time) AS error_text,
  argMax(lower(ifNull(result_output, '')), updated_date_time) AS output_hex
FROM default.canonical_execution_traces
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25656293 AND 25756720
  AND startsWith(lower(ifNull(result_output, '')), '0x4e487b71')
GROUP BY
  block_number,
  transaction_hash,
  internal_index,
  trace_address;
```

[`0x4e487b71` is Solidity's `Panic(uint256)` selector](https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require). The final word supplied the panic code: `0x11` for arithmetic overflow or underflow and `0x12` for division or modulo by zero. I then fetched canonical transaction status for the exact returned hashes in literal batches of 1,500; I did not make a distributed join decide whether a missing match meant failure.

```sql
-- Step 2: run once per literal hash batch returned by Step 1.
SELECT
  transaction_hash,
  argMax(success, updated_date_time) AS root_success
FROM default.canonical_execution_transaction
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25656293 AND 25756720
  AND transaction_hash IN (
    /* up to 1,500 literal hashes from Step 1 */
  )
GROUP BY transaction_hash;
```

The two arithmetic codes produced **8,120 deduplicated child-frame traces in 5,772 transactions**. Of those transactions, **5,333 succeeded and 439 failed**, a 92.39% success rate. At trace grain, 6,918 of 8,120 panics sat inside successful transactions; the lower 85.20% share reflects transactions that panicked more than once.

The panic surface is tiny, about **0.0167% of 34,598,710 transactions** in the window. I used the refined daily counter only for that denominator and checked its block counts against the raw canonical block bounds.

```sql
SELECT sum(total_transactions) AS total_transactions
FROM mainnet.fct_execution_transactions_daily FINAL
WHERE day_start_date >= toDate('2026-08-01')
  AND day_start_date <  toDate('2026-08-15');
```

![Arithmetic panic traces split by successful and failed root transaction receipts](/img/eip-8219-arithmetic-panics.png)

Code `0x11` accounted for 7,277 traces: 6,134 were inside green transactions and 1,143 were inside failed ones. Code `0x12` was smaller and even less terminal, with 784 of 843 traces inside green transactions.

## Aqua is the weird part

One contract explains most of the `0x11` pile. The verified [1inch Aqua contract](https://eth.blockscout.com/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) produced **5,589 underflow traces**, 76.80% of every `0x11` trace in the window. Every call came from the 1inch SwapVM router and used `pull(address,bytes32,address,uint256,address)`.

The source makes the failure plain. [`Aqua.pull()`](https://github.com/1inch/aqua/blob/8b09825ac13dc1bc6ebee66ca43a717057dd119c/src/Aqua.sol) loads a packed strategy balance, then executes the checked subtraction below. Asking to pull more than `prevBalance` produces Solidity panic `0x11` before the token transfer.

```solidity
(uint248 prevBalance, uint8 tokensCount) = balance.load();
balance.store(prevBalance - amount.toUint248(), tokensCount);
```

I fetched every Aqua `pull()` frame for the 4,729 transactions containing one of those underflows. **4,722 transactions succeeded**, and those same 4,722 made a successful Aqua pull later in the transaction. This does not prove the later pull was a retry of the same route, but it does rule out the simple story that the underflow ended execution.

One exact trace is unusually readable. [Transaction `0x6ba3…f4bf`](https://eth.blockscout.com/tx/0x6ba3661719b6a847ab46700cc9db0c0919f7c78fd3e5804e016423796ec0f4bf) hit an Aqua `pull()` underflow at internal index 29, made another successful Aqua `pull()` at index 30, and finished with a successful root receipt in block 25,756,717. A separate public RPC receipt returned status `0x1`, matching Xatu's canonical transaction row.

## The byte string is part of the boundary

EIP-8219 does not claim to preserve Solidity's panic ABI. It says the opposite: `SAFEADD`, `SAFESUB`, `SAFEMUL`, and `SAFEDIV` revert with empty returndata, while Solidity currently emits the selector and code. That is how the proposal gets a one-opcode failure path without building a revert payload in memory.

The data does not prove that each caller inspects those 36 bytes. It does show that arithmetic failure frequently lives inside successful outer control flow, with a machine-readable payload present at the call boundary. Compiler and library authors should treat the empty-returndata change as an observable compatibility choice, not merely the removal of a nicer error message.

There is no mainnet `SAFEADD` traffic to measure because EIP-8219 is still Draft. This is a baseline for the behavior a future compiler target would replace, not an adoption forecast or an argument that the proposal's gas trade is wrong.
