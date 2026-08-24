---
slug: eip5920-poolmanager-payment-veto
title: "Uniswap v4 rejected 104,998 ETH calls. PAY would not."
description: "A mainnet EIP-5920 counterfactual: Prism sent 104,998 empty-calldata value calls to Uniswap v4's PoolManager, which reverted every one and pushed 0.814 ETH into pending credits."
authors: aubury
tags: [ethereum, eip-5920, pay, evm, uniswap-v4, execution-traces, data]
date: 2026-08-24
---

[EIP-5920](https://eips.ethereum.org/EIPS/eip-5920) proposes a `PAY` opcode that moves ETH without running the recipient's code. It is Draft, and [a pull request proposing it for inclusion](https://github.com/ethereum/EIPs/pull/12078) merged on August 20. The pitch sounds like a cleaner, cheaper value transfer.

Mainnet has a better explanation. From July 2 through July 13, the Prism contract made **104,998 empty-calldata ETH calls** to Uniswap v4's PoolManager. PoolManager rejected every one. Prism caught almost all of those failures and booked **0.813726 ETH** as pending credit instead, which is exactly the branch `PAY` would skip.

<!-- truncate -->

<img src="/img/eip5920-poolmanager-payment-veto.png" alt="A dark two-panel chart shows 16.11 million empty-calldata internal ETH calls from August 10 through 23, of which 30.71% ran recipient code. A fixed Prism-to-Uniswap-v4 counterexample shows 104,998 attempts, 104,998 recipient reverts, zero accepted calls, and 104,924 committed pending-credit logs." loading="eager" />

## PAY is not CALL with a discount

The proposed opcode takes a recipient and a value. If the caller has enough balance, it transfers the ETH, marks the recipient warm and pushes success. It does not open a new frame, forward gas or execute a receive function. The recipient gets no chance to accept, reject or do anything clever before control returns to the sender.

That last sentence is the point. A normal value-bearing `CALL` lets recipient code decide whether the call succeeds. `PAY` gives that decision to the sender, subject only to its own balance. This post is a historical counterfactual about that semantic change; EIP-5920 is not active on mainnet and no existing `CALL` changes by itself.

## The current CALL surface is large

I first counted the broad surface in the latest 14 complete UTC days, August 10 through August 23. Blocks **25,720,868 through 25,821,305** contained 100,438 canonical blocks and **16,105,449** non-root `CALL` frames with nonzero value and empty calldata. Of those, **4,945,426**, or **30.71%**, consumed recipient gas. Another 780 reverted at the recipient frame.

This is the bounded query. The row grain is one canonical trace frame, not a transaction, user or independent payment:

```sql
SELECT
    count() AS empty_value_calls,
    uniqExact((t.block_number, t.transaction_hash, t.internal_index))
        AS unique_frames,
    countIf(t.result_gas_used > 0) AS recipient_code_ran,
    countIf(t.error IS NOT NULL AND t.error != '') AS recipient_reverted
FROM default.canonical_execution_traces AS t FINAL
WHERE t.meta_network_name = 'mainnet'
  AND t.block_number BETWEEN 25720868 AND 25821305
  AND t.trace_address IS NOT NULL
  AND t.action_type = 'call'
  AND t.action_call_type = 'call'
  AND t.action_value > 0
  AND (
      t.action_input IS NULL
      OR t.action_input = ''
      OR t.action_input = '0x'
  );
```

The row and unique-frame counts matched. On a separate 1,001-block slice, all **195,302** of these trace frames matched `canonical_execution_native_transfers FINAL` on block, transaction, internal index, sender, recipient and exact value. I did not sum ETH across the broad cohort because a few failed trace rows contain wrapped `UInt256` values; that data issue does not affect the frame counts or the exact Prism cohort below.

## PoolManager said no 104,998 times

The weird row was one caller and one recipient. Prism at [`0xbd3a…0040`](https://eth.blockscout.com/address/0xbd3ab5859f244cc9f51ee0ca755c5cf663d80040) called Uniswap v4's PoolManager at [`0x0000…8a90`](https://eth.blockscout.com/address/0x000000000004444c5dc75cb358380d2e3de08a90) 104,998 times in a fixed 14-day window. Every frame had empty calldata, nonzero value, `error = 'Reverted'` and exactly 50 gas used by the recipient frame.

Prism's verified source explains the pattern. Its private `_claimOne` function calculates ETH owed to an NFT owner, tries an empty-calldata call, then records a pending balance when the owner rejects it:

```solidity
(bool ok,) = owner.call{value: owedETH}("");
if (!ok) {
    pendingETH[owner] += owedETH;
    emit PendingCredited(owner, owedETH, 0);
}
```

For these frames, `owner` resolved to PoolManager. The deployed PoolManager source has no `receive()` or fallback function, so an empty call does not quietly deposit ETH. It reverts. Prism treats that as an accounting event rather than a fatal error.

I pulled the trace frames and `PendingCredited` logs separately, decoded the two `uint256` data words, then reconciled them locally at transaction grain. This is the executed path in compact form:

```python
traces = clickhouse.query("clickhouse-raw", """
    SELECT block_number, transaction_hash, internal_index, action_value
    FROM default.canonical_execution_traces FINAL
    WHERE meta_network_name = 'mainnet'
      AND block_number BETWEEN 25426767 AND 25527154
      AND lowerUTF8(action_from) =
          '0xbd3ab5859f244cc9f51ee0ca755c5cf663d80040'
      AND lowerUTF8(action_to) =
          '0x000000000004444c5dc75cb358380d2e3de08a90'
      AND trace_address IS NOT NULL
      AND action_type = 'call'
      AND action_call_type = 'call'
      AND action_value > 0
      AND action_input IS NULL
""")

logs = clickhouse.query("clickhouse-raw", """
    SELECT block_number, transaction_hash, log_index, data
    FROM default.canonical_execution_logs FINAL
    WHERE meta_network_name = 'mainnet'
      AND block_number BETWEEN 25426767 AND 25527154
      AND lowerUTF8(address) =
          '0xbd3ab5859f244cc9f51ee0ca755c5cf663d80040'
      AND lowerUTF8(topic0) =
          '0xe992e5edd2a9058442e44178788b99aee673ab9ac3f4220f33a463e8614bf235'
      AND lowerUTF8(topic1) =
          '0x000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90'
""")

logs["eth_amount"] = logs.data.map(
    lambda value: int(value[2:66], 16)
)
trace_by_tx = traces.groupby(["block_number", "transaction_hash"]).agg(
    calls=("internal_index", "size"),
    attempted_wei=("action_value", lambda s: sum(map(int, s))),
)
log_by_tx = logs.groupby(["block_number", "transaction_hash"]).agg(
    credits=("log_index", "size"),
    credited_wei=("eth_amount", "sum"),
)
check = trace_by_tx.merge(log_by_tx, how="outer", indicator=True)
```

There were 548 outer transactions. In **547 successful roots**, all **104,924** failed calls matched `PendingCredited` logs one for one, and their attempted wei matched the decoded event amounts in every transaction. Those committed credits totalled **0.813726016488026815 ETH**. One failed root made the remaining 74 attempts, then rolled back the whole transaction and its logs; including those reverted attempts brings the trace total to **0.813744490514236309 ETH**.

One public transaction makes the loop easy to inspect. [`0x13a5…0846`](https://eth.blockscout.com/tx/0x13a558d5cb9a95a5631b122c14a978928f15a749349d8e772e976d25dab90846) called `harvestRange(0, 200)`, succeeded at the root, and contained 200 matching failed calls plus 200 `PendingCredited` logs. I paged the public Blockscout logs separately and got the same 200 events, independent of the Xatu tables.

The pending balance did not disappear with the sample window. A public `eth_call` at block **25,824,154** on August 24 returned **1.206056065280780044 ETH** for Prism's `pendingETH(PoolManager)` mapping. That is a current cumulative state check, not an attribution of the whole 1.206 ETH to these 12 active days; the exact trace-to-log reconciliation supports only the 0.813726 ETH above.

## What changes under PAY

If Prism deliberately replaced these calls with `PAY`, PoolManager's code would not run. The exact historical attempts would have transferred value whenever Prism had sufficient balance, Prism's failure branch would not have credited `pendingETH`, and the 50-gas reverts would vanish. That is a control-flow change, not merely a gas discount.

It is not evidence that PoolManager becomes exploitable, and it is not a claim that Prism or any other contract will adopt the opcode. Ethereum contracts already cannot keep an absolute veto over their raw ETH balance because value can be forced through mechanisms such as `SELFDESTRUCT`; EIP-5920 says this directly in its security discussion. The concrete difference here is on the sender side: `CALL` let Prism observe rejection and preserve the obligation in its own accounting, while `PAY` would make the transfer itself the success path.

That is the useful way to read `PAY`: a new promise from the sender that the recipient does not get a turn.
