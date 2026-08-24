---
slug: eip8253-storage-ghosts
title: "One hundred green receipts went to code that does not exist"
description: "The 28 storage-only accounts behind draft EIP-8253 still hold 16.195452 ETH and 129 non-zero slots. Xatu shows 100 direct transactions into them, all successful."
authors: aubury
tags: [ethereum, eip-8253, eip-7610, glamsterdam, evm, state, xatu, panda]
date: 2026-08-25
---

[EIP-7610](https://eips.ethereum.org/EIPS/eip-7610) was declined for Glamsterdam last week. It would have made `CREATE` and `CREATE2` revert when the destination already had non-empty storage. The live Mainnet edge case is a small fossil: 28 accounts with storage, nonce zero and no code.

Those accounts do not look dead when you inspect their transaction history. Xatu has **100 direct transactions into 22 of them, and all 100 receipts say success**. Ninety carried calldata. Twenty-five used selectors that resolve to `withdraw` or `refund` functions, while another 11 looked like attempts to destroy the contract that was not there.

<!-- truncate -->

<img src="/img/eip8253-storage-ghosts.png" alt="Dark horizontal bar chart of 100 direct Ethereum transactions to the 28 EIP-8253 storage-only accounts. The chart groups 25 withdraw or refund calls, 23 balance reads, 17 other methods, 14 deposits, 11 destroy or kill calls and 10 empty transfers. All 100 transactions succeeded even though every target had zero runtime code. A callout shows a June 21, 2026 withdraw call requesting 0.2 ETH from a target holding 0.1109 ETH; the receipt succeeded, but the balance did not move." loading="eager" />

## The state is still there

Draft [EIP-8253](https://eips.ethereum.org/EIPS/eip-8253) publishes the [exact target set](https://github.com/ethereum/EIPs/blob/master/assets/eip-8253/targeted-accounts.json). These are contracts created before Spurious Dragon whose constructors left storage behind but returned no runtime bytecode. The proposal's asset lists 28 addresses and 129 storage slots, then proposes a one-time state change that bumps each nonce from zero to one.

I used that asset as an address-and-slot manifest, not as a current balance snapshot. Its `balance` fields come from the block 2,675,000 boundary scan described in the proposal methodology. They sum to 16.193553 ETH, which is 0.001899 ETH below the later state I measured.

At canonical block **25,826,078** (`0xb20a6c89...d11fde`), I requested `eth_getProof` for all 129 listed keys. The RPC returned 129 non-zero values, all 28 storage roots matched the EIP asset's `currentStorageHash`, and every account still had nonce zero plus the empty-code hash. Their balances summed to **16.19545200000011 ETH**.

The raw contract table agreed on the creation side. All 28 addresses appeared once between blocks 72,586 and 982,481, across 22 distinct init-code byte strings. Every row had a non-empty constructor and zero runtime bytes:

```sql
SELECT
    count() AS creation_rows,
    uniqExact(lowerUTF8(contract_address)) AS target_accounts,
    countIf(n_code_bytes = 0) AS zero_runtime_rows,
    uniqExact(init_code) AS exact_init_code_variants,
    min(block_number) AS first_creation_block,
    max(block_number) AS last_creation_block,
    sum(toUInt64(n_init_code_bytes)) AS total_init_code_bytes,
    sum(toUInt64(n_code_bytes)) AS total_runtime_bytes
FROM default.canonical_execution_contracts FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 0 AND 1000000
  AND lowerUTF8(contract_address) IN (<28 literal EIP-8253 addresses>);
```

That returned 28 creations, 28 targets, 28 zero-runtime rows, 102,819 constructor bytes and **zero runtime bytes**. These are not ordinary empty EOAs that happen to own ETH. They are failed-looking contract deployments with persistent storage.

## One hundred transactions into nothing

A single all-history scan of the transaction table is wasteful, so I ran the same bounded query over six non-overlapping five-million-block ranges and concatenated the results locally. The last range ended at the fixed proof block:

```python
targets = json.load(open("/tmp/targeted-accounts.json"))
target_sql = ", ".join(repr(row["address"].lower()) for row in targets)

ranges = [
    (0, 4_999_999),
    (5_000_000, 9_999_999),
    (10_000_000, 14_999_999),
    (15_000_000, 19_999_999),
    (20_000_000, 24_999_999),
    (25_000_000, 25_826_078),
]

frames = []
for lo, hi in ranges:
    frames.append(clickhouse.query("clickhouse-raw", f"""
        SELECT
            block_number,
            transaction_hash,
            lowerUTF8(to_address) AS target_address,
            lowerUTF8(from_address) AS sender_address,
            toString(value) AS value_wei,
            input,
            n_input_bytes,
            success,
            gas_used
        FROM default.canonical_execution_transaction FINAL
        WHERE meta_network_name = 'mainnet'
          AND block_number BETWEEN {lo} AND {hi}
          AND lowerUTF8(to_address) IN ({target_sql})
        ORDER BY block_number, transaction_hash
    """))

calls = pandas.concat(frames, ignore_index=True)
```

The six ranges returned 100 rows and 100 unique hashes. All 100 had `success = true`; 90 contained calldata; 32 transferred positive value, totalling **11.66045200000011 ETH**. A second address-by-address pull from Blockscout returned the same 100 transaction hashes, with no mismatches in block, sender, target, value, input, status or gas used.

I grouped the first four calldata bytes through verified rows in Panda's `mainnet.dim_function_signature FINAL`. The labels are selector-shaped, not proof of what each sender intended, but the mix is hard to mistake:

| Calldata shape | Direct transactions |
|---|---:|
| `withdraw` / `refund` | 25 |
| balance read | 23 |
| other contract method | 17 |
| `deposit` | 14 |
| `destroy` / `kill` / `selfdestruct` / `suicide` | 11 |
| empty transfer | 10 |
| **Total** | **100** |

The destroy bucket includes one malformed transaction that sent the ASCII text `41c0e1b5`, the hex selector for `kill()`, instead of sending those four selector bytes. The rest of the named methods resolved directly through verified signatures.

The transaction history runs from block 72,608 to block 25,367,094. It extends well past the early deployment mess. Three calls landed on June 21, 2026.

## Green does not mean the function ran

One of those June transactions is the cleanest example. [Transaction `0xbce544...e6846`](https://etherscan.io/tx/0xbce544bf15a31be198bc3f472b06fda12539992df766bb44d84277790f1e6846) sent `withdraw(uint256)` calldata to `0xf468...db71`, asking for **0.2 ETH**. The target held only 0.1109 ETH.

The receipt still succeeded after 21,660 gas. An exact-block RPC check showed `eth_getCode = 0x`, zero transaction value, and the same 0.1109 ETH balance before and after block 25,367,076. Nothing checked the requested amount because there was no code to check it. The calldata was accepted and ignored.

That is normal EVM behaviour. A top-level transaction to an account with no code can succeed after paying intrinsic gas; if it carries ETH, the value transfer can still increase the account balance. If it carries only calldata, there is simply nothing to execute. A green receipt proves that the transaction did not revert, not that a function existed or returned the thing its sender expected.

For these 28 accounts, incoming ETH is especially ugly. The addresses came from contract creation rather than usable private keys, and the accounts have no runtime code that can send the balance back out. The state is readable through RPC, but the contract cannot reach it.

## What the nonce bump would fix

[EIP-7610's removal PR](https://github.com/ethereum/EIPs/pull/12189) merged on August 20. Its permanent creation-time check was declined for Glamsterdam, and EIP-8253 remains a Draft rather than a scheduled fork change. The narrower draft would edit only these 28 accounts once, setting each nonce to one so [the existing creation-collision rule](https://eips.ethereum.org/EIPS/eip-684) rejects any future deployment at the same address.

That nonce bump would not unlock the 16.195452 ETH, erase the 129 slots or make later calldata transactions fail. It would only stop a future `CREATE` or `CREATE2` collision from replacing one of these storage roots under today's permissive zero-nonce edge case.

These are not contracts in the useful sense. They are state-trie fossils that still accept money and return green receipts. EIP-8253 would make sure they stay fossils.
