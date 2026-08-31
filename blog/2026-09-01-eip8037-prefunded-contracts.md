---
slug: eip8037-prefunded-contracts
title: "8,980 code deployments landed on addresses that already held ETH"
description: "Across 14 complete August days, 8,980 successful non-empty creation frames targeted addresses with positive prestate balances. EIP-8037 treats those leaves as already existent, so the account-creation charge belongs to the earlier funding step rather than deployment."
authors: aubury
tags: [ethereum, execution, contracts, eip-8037, eip-2780, state, data]
date: 2026-09-01
---

A contract address can hold ETH before it has bytecode. That sounds like EVM trivia until a gas proposal has to decide whether deploying the code creates a new account or updates one that is already there.

Across 14 complete August days, **8,980 successful code deployments landed on addresses with a positive prestate balance**. That was **1.03%** of comparable creation frames, and the addresses held **5,989.950758 ETH** in total before their deployment transactions began.

<!-- truncate -->

<img src="/img/eip8037-prefunded-contracts.png" alt="Dark chart showing 8,980 successful non-empty code deployments to prefunded Mainnet addresses from August 17 through 30, 2026. The cohort is 1.03% of 868,665 comparable creation frames and carried 5,989.95 ETH in transaction-prestate balances. ForwarderFactoryV4 accounts for 1,770 deployments, while a callout shows the largest starting balance at 1,197.923 ETH." loading="eager" />

The immediate trigger was a tiny edit. [EIPs PR #12246](https://github.com/ethereum/EIPs/pull/12246), merged on August 31, added "or a non-zero balance" to EIP-8037's description of an existing account. The edit is one clause long. Mainnet makes the clause look much less academic.

[EIP-684](https://eips.ethereum.org/EIPS/eip-684) rejects contract creation when the destination already has a nonzero nonce or nonempty code. Balance is not part of that collision test. A deterministic address can receive ETH first, then accept code later while the balance sits on the same account leaf.

## The account came first

I looked at blocks **25,771,074 through 25,871,535**, the 100,462 canonical blocks from August 17 through 30 UTC. `canonical_execution_balance_reads` is transaction-prestate account data, not a count of `BALANCE` opcodes, so a positive row at the created address means the ETH was present before that transaction executed.

The creation table is a frame surface, which is an easy place to overcount. I joined every candidate back to its root transaction, required `success`, and required a nonempty runtime for the headline. This is the executed headline query:

```sql
SELECT
  countIf(p.n_code_bytes > 0) AS prefunded_code_deployments,
  uniqExactIf(lower(p.contract_address), p.n_code_bytes > 0) AS deployed_addresses,
  uniqExactIf(p.transaction_hash, p.n_code_bytes > 0) AS deployment_transactions,
  sumIf(toUInt256(p.prebalance), p.n_code_bytes > 0) AS prestate_balance_wei,
  maxIf(toUInt256(p.prebalance), p.n_code_bytes > 0) AS largest_prestate_balance_wei,
  countIf(p.n_code_bytes = 0) AS zero_runtime_create_frames
FROM default.canonical_execution_transaction AS t FINAL
GLOBAL INNER JOIN
(
  SELECT
    c.block_number AS creation_block,
    c.transaction_hash AS transaction_hash,
    c.internal_index AS creation_internal_index,
    c.contract_address AS contract_address,
    c.factory AS factory,
    c.n_code_bytes AS n_code_bytes,
    b.balance AS prebalance
  FROM default.canonical_execution_balance_reads AS b FINAL
  GLOBAL INNER JOIN
  (
    SELECT
      meta_network_name,
      block_number,
      transaction_hash,
      internal_index,
      contract_address,
      factory,
      n_code_bytes
    FROM default.canonical_execution_contracts FINAL
    WHERE meta_network_name = 'mainnet'
      AND block_number BETWEEN 25771074 AND 25871535
  ) AS c
    ON b.meta_network_name = c.meta_network_name
   AND b.block_number = c.block_number
   AND b.transaction_hash = c.transaction_hash
   AND lower(b.address) = lower(c.contract_address)
  WHERE b.meta_network_name = 'mainnet'
    AND b.block_number BETWEEN 25771074 AND 25871535
    AND b.balance > 0
) AS p
  ON t.block_number = p.creation_block
 AND t.transaction_hash = p.transaction_hash
WHERE t.meta_network_name = 'mainnet'
  AND t.block_number BETWEEN 25771074 AND 25871535
  AND t.success;
```

That returned **8,980 frames**, **8,979 distinct addresses**, and **8,385 transactions**. The one-address difference is why I am calling these deployments rather than unique contracts. Another 2,461 successful prefunded creation frames produced zero runtime bytes and stay outside the headline.

The denominator used the same transaction-success gate without the balance join:

```sql
SELECT
  countIf(c.n_code_bytes > 0) AS successful_nonempty_create_frames,
  countIf(c.n_code_bytes = 0) AS successful_zero_runtime_create_frames
FROM default.canonical_execution_transaction AS t FINAL
GLOBAL INNER JOIN
(
  SELECT meta_network_name, block_number, transaction_hash, n_code_bytes
  FROM default.canonical_execution_contracts FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25771074 AND 25871535
) AS c
  ON t.meta_network_name = c.meta_network_name
 AND t.block_number = c.block_number
 AND t.transaction_hash = c.transaction_hash
WHERE t.meta_network_name = 'mainnet'
  AND t.block_number BETWEEN 25771074 AND 25871535
  AND t.success;
```

It returned **868,665 successful nonempty creation frames**, putting the prefunded share at **1.033770%**. Raw and refined creation tables differed by five rows in the full window, but all five belonged to one failed out-of-gas root transaction. The success gate removed the discrepancy instead of averaging it away.

The second check was at trace grain. Every one of the 8,980 candidates matched exactly one `create` trace at the same `(block, transaction, result_address)`. All 8,980 had a null error and zero create endowment. For the 7,078 candidates with a transaction-final balance diff, `from_value` matched the prestate balance exactly; the other 1,902 had no diff row rather than a conflicting value.

## Mostly factories doing factory things

The shape is not a random sample of contract deployment. Verified Blockscout source names identify **ForwarderFactoryV4** at 1,770 deployments, **GlideDepositFactory** at 616, another **ForwarderFactory** at 585, **ERC1967Proxy** at 565, and **CoinbaseSmartWalletFactory** at 563. The named and two largest unlabelled groups in the chart account for 5,921 deployments; the remaining 3,059 are folded into "other factories."

The largest balance makes the ordering obvious. In [transaction `0x569b...c493`](https://eth.blockscout.com/tx/0x569b553908440a1f52c1732165cfd14fb1e37d3e16c30a1d6f711e22ccd1c493), `ForwarderFactory` created a 45-byte proxy at `0xe560...d0e3` with zero endowment. The address already held **1,197.923 ETH**. Its balance diff went from 1,197.923 ETH to zero, and Blockscout's independent internal-call view shows the new forwarder sending that exact amount later in the same successful transaction.

## The charge moved, it did not vanish

[EIP-8037](https://eips.ethereum.org/EIPS/eip-8037) is in Review and Scheduled for Inclusion in Glamsterdam. Its current constants charge `120 state bytes × 1,530 gas/byte = 183,600 state gas` when an operation creates a new account leaf. The proposal now says a balance-only destination already has that leaf, so these deployments pay code-byte state gas but skip the account-creation component at deployment time.

A naive backcast that charged every one of the 8,980 deployments as a fresh account would add **1,648,728,000 state gas** in the wrong place. That is not a loophole or free state. Under [EIP-2780](https://eips.ethereum.org/EIPS/eip-2780), a positive-value transfer to a previously nonexistent address pays the same new-account state charge when the funding transaction runs after activation.

The account arrived first. The code arrived later. EIP-8037's one-line clarification makes the meter follow that order.
