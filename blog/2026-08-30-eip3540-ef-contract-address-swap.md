---
slug: eip3540-ef-contract-address-swap
title: The EOF EIP put the farewell on the wrong contract
description: Mainnet has exactly three pre-London contracts whose runtime starts with 0xEF, but EIP-3540 assigns the nine-byte farewell runtime to the wrong address.
authors: aubury
tags: [ethereum, evm, eip-3540, eip-3541, eip-8298, data]
date: 2026-08-30
---

Ethereum has exactly three contracts whose runtime starts with `0xEF`. An August 28 [update to Draft EIP-8298](https://github.com/ethereum/EIPs/pull/12259) says as much, but the old EOF EIP that names the three attaches the nine-byte farewell to the wrong address.

<!-- truncate -->

The count is right. The address map is not.

## Three rows, two byte strings

[EIP-3541](https://eips.ethereum.org/EIPS/eip-3541) reserved `0xEF` at London. New contract creation fails when the returned runtime begins with that byte, but code deployed before block 12,965,000 stayed in state. EIP-8298 now cites three such contracts in its backwards-compatibility section because its proposed `SETCODEFROM` instruction would reject all three as code sources.

I scanned the complete creation range through the London activation block instead of carrying the number across from the EIP:

```sql
SELECT
  block_number,
  transaction_hash,
  internal_index,
  lower(contract_address) AS contract_address,
  n_code_bytes,
  lower(code) AS runtime_code
FROM default.canonical_execution_contracts FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 0 AND 12965000
  AND startsWith(lower(ifNull(code, '')), '0xef')
ORDER BY block_number, transaction_hash, internal_index;
```

That returns three rows, three addresses and two exact runtime byte strings:

- [`0xca7b…aa01`](https://etherscan.io/address/0xca7bf67ab492b49806e24b6e2e4ec105183caa01), deployed at block 12,479,124: `0xEF`.
- [`0x897d…47ec`](https://etherscan.io/address/0x897da0f23ccc5e939ec7a53032c5e80fd1a947ec), deployed at block 12,936,025: `0xEF`.
- [`0x6e51…5cd0`](https://etherscan.io/address/0x6e51d4d9be52b623a3d3a2fa8d3c5e3e01175cd0), deployed at block 12,964,797: `0xEFF09F918BF09F9FA9`.

I used the runtime bytes directly. The raw contract table's `code_hash` and `init_code_hash` names are currently swapped relative to their documented meanings, so grouping on either field would have been an unnecessary way to get this wrong.

<a href="/img/eip3540-ef-contract-address-swap.png"><img src="/img/eip3540-ef-contract-address-swap.png" alt="Dark vertical timeline of the three Mainnet contracts deployed before London whose runtime starts with 0xEF. The first two addresses contain the one-byte runtime 0xEF. The third, 0x6e51…5cd0, contains the nine-byte 0xEF farewell followed by the UTF-8 bytes for a waving hand and green square. A callout shows that EIP-3540 assigns those nine bytes to the first address instead. The final card shows the farewell landing 203 blocks and 42 minutes 38 seconds before London activation." loading="eager" /></a>

## The farewell landed with 42 minutes left

The current [EIP-3540](https://eips.ethereum.org/EIPS/eip-3540) rationale lists the same three addresses, but says `0xca7…aa01` holds `EFF09F918BF09F9FA9` and `0x6e51…5cd0` holds only `EF`. Mainnet says the opposite. The first and third runtime assignments are swapped.

The transaction inputs make the mismatch hard to explain away as a later state change. Panda's canonical transaction row for `0xca7…aa01` contains initcode `0x60ef60005360016000f3`, which returns the single byte `EF`. The creation input for `0x6e51…5cd0` ends with the full nine-byte runtime. Two current public RPC paths, Flashbots and PublicNode, also return `0xef`, `0xef` and `0xeff09f918bf09f9fa9` for the three addresses in that order.

Those last eight bytes are valid UTF-8 after the leading `EF`: `F0 9F 91 8B` is 👋 and `F0 9F 9F A9` is 🟩. The deployer later described it on the [EOF discussion thread](https://ethereum-magicians.org/t/evm-object-format-eof/5727/22) as a "farewell message to 0xef before EIP-3541 took effect."

It was close. I pulled the three creation blocks and the London block from the canonical block table:

```sql
SELECT
  block_number,
  block_date_time,
  block_hash
FROM default.canonical_execution_block FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number IN (12479124, 12936025, 12964797, 12965000)
ORDER BY block_number;
```

The farewell contract landed at 11:51:04 UTC on August 5, 2021. London activated 203 blocks and 2,558 seconds later, at 12:33:42 UTC.

## The consensus rule is still fine

This is a documentation error, not a chain bug. EIP-3540 is Stagnant, EIP-3541's London rule does not depend on which address owns which bytes, and Draft EIP-8298 only claims there are three excluded sources. That claim survives.

The practical conclusion survives too. `0xEF` is undefined at program counter zero, so an ordinary call into any of these runtimes aborts before reaching the farewell bytes. Current RPC state shows all three code blobs still present with zero balance, and the public explorer history contains only their creation transactions.

The count survived the recheck. The farewell belongs to `0x6e51…5cd0`.
