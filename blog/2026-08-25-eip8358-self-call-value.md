---
slug: eip8358-self-call-value
title: "61,778 value calls went straight back to the same address"
description: "A naive Mainnet self-transfer query returned 122,453 positive-value rows. Only 61,778 were internal CALLs, and 74.5% came from RelayRouterV3 calling its own receive function."
authors: aubury
tags: [ethereum, evm, gas, eip-8358, calls, data]
date: 2026-08-25
---

At first glance, Mainnet made 122,453 positive-value transfers from an address to itself in 14 days. That is a silly number. It is also wrong for the question [draft EIP-8358](https://github.com/ethereum/EIPs/blob/c656c4e42c3c66db843f82035d521abc8e836b51/EIPS/eip-8358.md) is trying to answer.

<!-- truncate -->

<img src="/img/eip8358-self-call-value.png" alt="A dark chart classifying 122,453 positive-value Mainnet trace rows where sender and recipient matched. It removes 42,333 root transactions and 18,342 DELEGATECALL rows to leave 61,778 internal self-CALLs. RelayRouterV3 produced 46,024 of them, or 74.5 percent. The draft EIP-8358 dependency schedule reduces the self-CALL value component from 8,000 to 4,000 gas, with a note that this is not a Mainnet replay." loading="eager" />

The EIP is not merged, and the canonical EIPs site does not have it. Its text still lives in [open PR #12058](https://github.com/ethereum/EIPs/pull/12058), while its dependencies are only [scheduled for inclusion](https://eips.ethereum.org/EIPS/eip-7773). Mainnet's current execution spec still sets `CALL_VALUE` to 9,000 gas and uses the old additive 2,300-gas stipend. This post measures the workload shape behind the proposal; it does not pretend the draft already runs on Mainnet.

## The count was wrong twice

I froze 14 complete UTC days, 10 through 23 August. The raw execution-block table and refined `fct_block` returned the same 100,438 canonical blocks, the same bounds and the same block-hash fingerprint.

```sql
-- clickhouse-raw
SELECT
  count() AS blocks,
  min(block_number) AS min_block,
  max(block_number) AS max_block,
  groupBitXor(cityHash64(block_hash)) AS hash_fingerprint
FROM default.canonical_execution_block FINAL
WHERE meta_network_name = 'mainnet'
  AND block_date_time >= toDateTime('2026-08-10 00:00:00')
  AND block_date_time <  toDateTime('2026-08-24 00:00:00');

-- clickhouse-refined, independently executed
SELECT
  count() AS blocks,
  min(block_number) AS min_block,
  max(block_number) AS max_block,
  groupBitXor(cityHash64(execution_payload_block_hash)) AS hash_fingerprint
FROM mainnet.fct_block FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-10 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-24 00:00:00');
```

Both paths returned blocks 25,720,868 through 25,821,305 and fingerprint `13703266030214691544`. The tempting next query is one line: count rows in `canonical_execution_native_transfers` where `from_address = to_address` and `value > 0`. It returns 122,453.

That table is too broad for this EIP. Matching the exact `(block_number, transaction_hash, internal_index)` keys back to canonical traces showed that all 122,453 rows came from the following three shapes:

```sql
SELECT
  action_call_type,
  count() AS rows,
  countIf(trace_address IS NULL) AS root_rows,
  countIf(trace_address IS NOT NULL) AS internal_rows,
  uniqExact(transaction_hash) AS transactions
FROM default.canonical_execution_traces FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25720868 AND 25821305
  AND action_type = 'call'
  AND action_value > 0
  AND lower(action_from) = lower(action_to)
GROUP BY action_call_type
ORDER BY rows DESC;
```

- `CALL`: 104,111 rows, split between 42,333 roots and 61,778 internal frames.
- `DELEGATE_CALL`: 18,342 rows, all internal.

A root transaction from an account to itself never executes a `CALL` opcode, so the 42,333 root rows are out. A `DELEGATECALL` carries the caller's value in trace context but does not transfer that value, so those 18,342 rows are out too. The actual self-call branch is the 61,778 internal `CALL` rows with positive value and identical sender and recipient. They appeared in 61,495 transactions and made up 0.34% of the window's 18,254,831 internal positive-value `CALL`s.

That distinction is not fussy SQL housekeeping. Without it, the obvious table overstates this particular proposal cohort by 98%. The draft also has a separate `CALLCODE` branch, but Mainnet produced only 39 positive-value internal `CALLCODE` rows in the same window.

## One router owns three quarters of it

The 61,778 self-calls were not spread evenly. Three addresses produced 97.2% of them, and the top address was not subtle.

```sql
SELECT
  lower(action_from) AS contract,
  count() AS self_calls,
  uniqExact(transaction_hash) AS transactions,
  countIf(error IS NOT NULL) AS own_errors,
  countIf(ifNull(action_input, '') = '') AS empty_inputs,
  min(action_gas) AS min_action_gas,
  min(result_gas_used) AS min_child_gas,
  max(result_gas_used) AS max_child_gas
FROM default.canonical_execution_traces FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25720868 AND 25821305
  AND trace_address IS NOT NULL
  AND action_type = 'call'
  AND action_call_type = 'call'
  AND action_value > 0
  AND lower(action_from) = lower(action_to)
GROUP BY contract
ORDER BY self_calls DESC
LIMIT 3;
```

- [`RelayRouterV3`](https://eth.blockscout.com/address/0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f?tab=contract): 46,024 self-calls in 46,002 transactions; 1,397 child gas every time.
- [`DexRouter`](https://eth.blockscout.com/address/0x28B1DC1A5e3699a428Bc51d234dFab7C9cb2A183?tab=contract): 9,165 self-calls in 9,165 transactions; 76 child gas every time.
- [`0xc10e...0fb4`](https://eth.blockscout.com/address/0xc10ee9031F2a0B84766a86B55A8d90f357910FB4): 4,848 self-calls in 4,833 transactions; 55 child gas every time.

RelayRouterV3 accounts for 74.5% of the whole cohort. Every one of its self-call frames had empty input, used exactly 1,397 gas and completed without its own trace error. The verified contract explains the odd shape:

```solidity
receive() external payable {
    emit SolverNativeTransfer(address(this), msg.value);
}
```

The router's `multicall` can send part of `msg.value` to the router itself. That hits `receive()`, emits the router's accounting event, and leaves the router's balance unchanged because sender and recipient are the same account. Of the 46,024 rows, 37,594 were direct outer calls to the router using the `multicall` selector; every matched self-call reused the outer transaction's exact value. The other 8,430 did not have RelayRouterV3 as the transaction's outer target.

One [public transaction](https://eth.blockscout.com/tx/0xb15766290fd01a6d0b9a77528839e820f44cad703aaba6502f8e21705ed28780) makes it concrete. The outer call sent 0.000375907958815931 ETH to RelayRouterV3. Its decoded multicall then called RelayRouterV3 with the same value and empty input, producing the 1,397-gas `receive()` frame before the router sent that value onward. Xatu's exact transaction trace and Blockscout's internal-call view agree on the sender, recipient and wei amount.

## What the draft would change

Under EIP-8358's dependency schedule, a positive-value self-`CALL` has no account-leaf changes to meter. The draft charges only a 4,000-gas base instead of the 8,000-gas value-call component in its post-EIP-8038 baseline. The blunt arithmetic over this historical cohort is `61,778 × (8,000 - 4,000) = 247,112,000` gas.

I would not call that 247.1 million gas of Mainnet savings. The dependent repricings are inactive, the draft replaces the additive stipend with a minimum gas floor, and contracts can branch on `gasleft()`. A faithful backcast needs a proposal-aware EVM replay, not a subtraction over traces. RelayRouterV3's 1,397-gas child body sat well below the proposed floor and every observed call forwarded at least 28,523 gas, but that is a compatibility check rather than proof of unchanged execution.

The part I trust is simpler. Mainnet really does contain a pocket of positive-value calls where the account leaf cannot change, and one router creates most of them merely to enter its own `receive()` function and emit an event. If net metering is supposed to charge for state work, this is the clean case: the transfer amount is real, the state change is not.
