---
slug: glamsterdam-balance-only-selfdestructs
title: 11 Glamsterdam contracts cleared themselves and left the ETH behind
description: Across seven complete devnet days, 11 successful creation transactions self-destructed to their own new address, left 45,959–61,659 wei in balance-only accounts, and pushed 16 erased storage accesses into the block access list.
authors: aubury
tags: [ethereum, eip-8246, eip-7928, selfdestruct, block-access-lists, glamsterdam, devnet, data]
date: 2026-09-01
---

Eleven successful Glamsterdam contract-creation transactions did something Mainnet still treats as an ETH burn. During initcode, each new address called `SELFDESTRUCT` with itself as beneficiary. The address finished with no code, nonce zero and empty storage, but its 45,959–61,659 wei balance survived.

That is [EIP-8246](https://eips.ethereum.org/EIPS/eip-8246) working as designed. The stranger part is what [EIP-7928](https://eips.ethereum.org/EIPS/eip-7928) kept: 16 storage keys from accounts whose storage ended empty, including eight `SSTORE` writes that were erased at transaction finalization.

<!-- truncate -->

<a href="/img/glamsterdam-balance-only-selfdestructs.png">
  <img src="/img/glamsterdam-balance-only-selfdestructs.png" alt="Dark stacked bar chart for August 25 through 31, 2026 on Glamsterdam devnet-8. Eleven successful top-level contract creations self-destructed to their own address. Their block access list entries retained 16 storage keys, split evenly between eight explicit SLOAD keys and eight implicit reads from SSTORE. The resulting accounts kept 45,959 to 61,659 wei while code, nonce and storage finished empty." loading="eager" />
</a>

## The burn that no longer burns

Mainnet's [EIP-6780](https://eips.ethereum.org/EIPS/eip-6780) still preserves the old deletion path when a contract calls `SELFDESTRUCT` in the same transaction that created it. If the beneficiary is the contract itself, that path burns the balance. EIP-8246 removes the burn but keeps the cleanup: code and storage are cleared, nonce returns to zero, and any nonzero balance leaves a balance-only account behind.

EIP-8246 is still in Review and is not a Mainnet rule. Glamsterdam devnet-8 is already exercising the behavior, which makes the edge case observable instead of hypothetical. A fresh [execution-specs regression test](https://github.com/ethereum/execution-specs/pull/3475), merged on August 31, sent me looking at the same cleanup seam from the block access list side.

## Find the balance-only creates

I froze seven complete UTC days, August 25 through 31. At `(slot, block_root, position)` grain, the canonical transaction surface contained 198,762 top-level creation rows. I computed each destination from `keccak256(rlp([sender, nonce]))`, then joined it to BAL accounts that had a positive balance change and at least one storage read, but no storage, nonce or code change.

This is the executed headline query. The RLP expression looks ugly because ClickHouse is doing the top-level `CREATE` address calculation directly; there is no mapping table hidden behind `created_address`.

```sql
WITH
creates0 AS (
    SELECT
        slot,
        block_root,
        hash AS transaction_hash,
        lower(`from`) AS sender,
        nonce,
        upper(hex(nonce)) AS nonce_hex
    FROM `glamsterdam-devnet-8`.canonical_beacon_block_execution_transaction FINAL
    WHERE meta_network_name = 'glamsterdam-devnet-8'
      AND slot_start_date_time >= toDateTime('2026-08-25 00:00:00')
      AND slot_start_date_time <  toDateTime('2026-09-01 00:00:00')
      AND `to` IS NULL
),
creates1 AS (
    SELECT
        *,
        if(
            nonce = 0,
            '80',
            if(
                nonce < 128,
                nonce_hex,
                concat(hex(toUInt8(128 + toUInt8(length(nonce_hex) / 2))), nonce_hex)
            )
        ) AS nonce_rlp
    FROM creates0
),
creates AS (
    SELECT
        slot,
        block_root,
        transaction_hash,
        concat(
            '0x',
            lower(right(hex(keccak256(unhex(concat(
                hex(toUInt8(192 + length(concat('94', upper(substring(sender, 3)), nonce_rlp)) / 2)),
                '94',
                upper(substring(sender, 3)),
                nonce_rlp
            )))), 40))
        ) AS created_address
    FROM creates1
),
candidates AS (
    SELECT
        slot,
        block_root,
        address,
        groupUniqArrayIf(storage_key, change_type = 'storage_read') AS storage_reads,
        argMaxIf(toUInt256(new_value), block_access_index, change_type = 'balance') AS post_balance_wei
    FROM `glamsterdam-devnet-8`.canonical_beacon_block_access_list FINAL
    WHERE meta_network_name = 'glamsterdam-devnet-8'
      AND slot_start_date_time >= toDateTime('2026-08-25 00:00:00')
      AND slot_start_date_time <  toDateTime('2026-09-01 00:00:00')
    GROUP BY slot, block_root, address
    HAVING countIf(change_type = 'storage_read') >= 1
       AND countIf(change_type = 'balance') > 0
       AND countIf(change_type = 'storage') = 0
       AND countIf(change_type = 'nonce') = 0
       AND countIf(change_type = 'code') = 0
)
SELECT
    count() AS matched_create_rows,
    uniqExact(cr.transaction_hash) AS matched_transaction_hashes,
    sum(length(c.storage_reads)) AS retained_storage_keys,
    min(c.post_balance_wei) AS min_post_balance_wei,
    max(c.post_balance_wei) AS max_post_balance_wei
FROM creates AS cr
GLOBAL INNER JOIN candidates AS c
    ON cr.slot = c.slot
   AND cr.block_root = c.block_root
   AND cr.created_address = c.address;
```

It returned 11 rows, 11 distinct transaction hashes and 16 retained keys. The smallest post-state balance was 45,959 wei; the largest was 61,659 wei. This is a deliberately narrow top-level cohort, not a count of internal `CREATE` or `CREATE2` frames.

## The BAL remembers the erased writes

The cleanest example landed at slot 126,910 in execution block 124,029. Transaction `0x4ebe…75b9` created `0xaa69…4ca9` with 58,434 wei, loaded storage slot zero, wrote slot `0x25d57`, then called `SELFDESTRUCT` with `0xaa69…4ca9` as its own beneficiary. Erigon and Nethermind returned the same successful receipt, created address and call tree.

Exact block-hash state reads were blunt. Before the block, the address had zero balance, nonce zero, empty code and zero in both slots. After the block, the balance was `0xe442` (58,434 wei), while nonce, code and both storage words were still empty. The BAL entry carried the balance change at block access index 2, both keys under `storage_reads`, and nothing under storage, nonce or code changes.

That is not loose naming. `SSTORE` implicitly reads the old word to price the write, and EIP-7928 says a destroyed account's touched storage belongs in `storage_reads` when no write survives. Across all 11 transactions, exact opcode traces produced eight ordinary `SLOAD` keys and eight implicit reads from `SSTORE`. Every key matched the corresponding BAL entry; none survived in post-state storage.

The August 31 regression test goes one step further by recreating and destroying the same prefunded `CREATE2` address twice. It was added because an earlier test used `REVERT` and missed the destruction path behind [Erigon issue #23407](https://github.com/erigontech/erigon/issues/23407). My 11 transactions are not that fixture, but they hit the same rule that makes an erased write remain consensus-visible as a read.

## Check the block, not only the table

The BAL table had one Xatu emitter, so I did not treat its row count as enough. I replayed every matched hash through exact Erigon and Nethermind endpoints. Both clients agreed on all 11 receipts, created addresses, self-beneficiaries, post-state balances, empty code, zero nonce and zero values for all 16 storage keys.

For the slot 126,910 block, I also checked the committed object across the full endpoint matrix. Thirty endpoints spanning Besu, Erigon, Ethrex, Nethermind and Reth returned the same 90,260 raw BAL bytes with SHA-256 `846ab5b5…319a1f`. Their Keccak-256 was `0x30863e15…52fc00`, exactly the block header's `blockAccessListHash`. Geth's six endpoints did not expose either BAL getter in the measured image; that is an RPC availability boundary, not a block disagreement. Reth's decoded keys needed the same left-padding normalization [I documented in the previous BAL post](/blog/reth-bal-json-width/), while its raw bytes matched everyone else.

The seven-day canonical block table contained 49,905 roots; the BAL table had at least one row for 49,800 of them. I have not guessed whether the 105-row gap is empty BALs or capture loss. The 11 reported events do not depend on that distinction because each one was rechecked by exact block, transaction and block-hash state reads.

## A devnet edge, on purpose

This is not a Mainnet frequency estimate. The devnet workload is synthetic, EIP-8246 remains under review, and the query cannot see internal creation frames. The proposal itself reports only two post-Cancun Mainnet burns through the old path by roughly block 25 million, which is a different chain and a different denominator.

The useful result is the state shape. Amsterdam deliberately leaves a non-executable balance leaf, while the BAL separately preserves storage touches that no longer exist. Clients have to agree on both halves, including the reads implied by writes that disappeared.
