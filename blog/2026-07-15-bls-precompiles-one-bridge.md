---
slug: bls-precompiles-one-bridge
title: "The BLS12-381 precompiles had one customer"
description: "Across 30.67M traced mainnet transactions, all 252 EIP-2537 call frames came from Wrapped Gonka's bridge. Five of the seven precompiles were unused."
authors: [aubury]
tags: [ethereum, evm, pectra, bls, precompiles, data]
date: 2026-07-15
---

Ethereum added seven BLS12-381 precompiles in Pectra. In two weeks of fresh call-frame data, five of them were never touched. The other two were called 126 times each, and every call came from the same contract.

That contract was not a staking protocol. It was a small cross-chain bridge minting Wrapped Gonka.

<!-- truncate -->

[EIP-2537](https://eips.ethereum.org/EIPS/eip-2537) gives EVM contracts cheap access to the BLS12-381 curve used by Ethereum's consensus signatures. It added separate precompiles for G1 and G2 addition, multi-scalar multiplication, pairing checks, and mapping field elements onto each group. [Pectra activated the set on mainnet](https://eips.ethereum.org/EIPS/eip-7600) in May 2025.

The useful distinction is that consensus clients do not call these precompiles to verify attestations. Consensus BLS work happens outside the EVM. These seven addresses are for contracts that want BLS arithmetic onchain, so I wanted to see who was actually using them.

Xatu's current call-frame history gave me 14 complete UTC days, June 27 through July 10, covering execution blocks **25,405,252 through 25,505,640**. It had root frames for **30,668,658 transactions**. The raw canonical transaction table had 30,671,396 hashes over the same blocks, so the traced surface covered **99.991%** of the canonical transactions.

I counted call frames whose target was one of EIP-2537's seven addresses:

```sql
SELECT
  target_address,
  count() AS frame_count,
  uniqExact(transaction_hash) AS transaction_count,
  sum(gas_cumulative) AS total_precompile_gas,
  countIf(error_count > 0) AS frames_with_error
FROM mainnet.int_transaction_call_frame FINAL
WHERE block_number BETWEEN 25405252 AND 25505640
  AND target_address IN (
    '0x000000000000000000000000000000000000000b',
    '0x000000000000000000000000000000000000000c',
    '0x000000000000000000000000000000000000000d',
    '0x000000000000000000000000000000000000000e',
    '0x000000000000000000000000000000000000000f',
    '0x0000000000000000000000000000000000000010',
    '0x0000000000000000000000000000000000000011'
  )
GROUP BY target_address
ORDER BY target_address;
```

Only two rows came back. The pairing-check precompile at `0x0f` had **126 frames and 12,965,400 gas**. The map-Fp-to-G1 precompile at `0x10` also had **126 frames**, costing 693,000 gas. The other five addresses had zero frames, including both multi-scalar-multiplication precompiles.

<a href="/img/bls-precompiles-one-bridge.png"><img src="/img/bls-precompiles-one-bridge.png" alt="Horizontal bar chart of Ethereum's seven BLS12-381 precompiles. Five had zero observed call frames. Pairing check at 0x0f and map Fp to G1 at 0x10 each had 126, all from the Wrapped Gonka bridge." loading="eager" /></a>

The symmetry was exact. All 126 transactions had three call frames: the bridge contract at the root, one `STATICCALL` to `0x10`, and one `STATICCALL` to `0x0f`. No other contract appeared as the parent. There were no failed precompile frames, and there were no transactions sent directly to any of the seven precompile addresses.

The address, [`0x972a…2f68`](https://eth.blockscout.com/address/0x972a7a92d92796a98801a8818bcf91f1648f2f68?tab=contract), is a verified `BridgeContract` that also serves as the Wrapped Gonka ERC-20. [Gonka's bridge documentation](https://gonka.ai/docs/cross-chain-transfers/ethereum-bridge/addresses-and-keys/) names the same Ethereum contract. Its source says it uses BLS threshold signatures to authorize bridge actions.

The code explains the two-bar chart. It hashes a bridge command, maps that hash into G1 with `0x10`, then asks `0x0f` to check two pairings: the submitted signature against the G2 generator, and the negated message point against the current group public key. Under EIP-2537's gas formula, a two-pair check costs `32600 * 2 + 37700 = 102900` gas. Mapping into G1 costs another 5,500, which reproduces the **108,400 gas** visible in every successful transaction before the bridge's ordinary contract work.

There were two entry points behind the 126 transactions: **111 `mintWithSignature` calls** and **15 `submitGroupKey` calls**. The raw transaction and log tables reproduced that split independently. One additional mint attempt failed before reaching the BLS calls, which is why the selector count was 112 while the successful mint event and precompile paths each stopped at 111.

```sql
SELECT
  substring(input, 1, 10) AS selector,
  count() AS transaction_rows,
  countIf(success) AS successful_rows,
  uniqExact(from_address) AS senders,
  sum(gas_used) AS total_gas_used
FROM default.canonical_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25405252 AND 25505640
  AND to_address = '0x972a7a92d92796a98801a8818bcf91f1648f2f68'
GROUP BY selector
ORDER BY transaction_rows DESC;
```

The relevant output was `0xb7c9e84a` (`mintWithSignature`) at 112 rows / 111 successes, and `0x969731f6` (`submitGroupKey`) at 15 / 15. `canonical_execution_logs` then had exactly **111 `WGNKMinted` events** and **15 `GroupKeySubmitted` events** over the same blocks.

The older raw `canonical_execution_traces` projection returned no rows for addresses `0x0b` through `0x11`. That table simply does not expose these precompile frames, while the structlog-derived call-frame model does. Without the new surface, this little pocket of BLS activity looked like zero.

This is a narrow observation, not a claim that nobody else has ever used EIP-2537. The call-frame history starts partway through June and lags the chain by several days, while 2,738 canonical transactions in the chosen block range had no root frame. Within the **30.67 million traced transactions**, though, the result is clean: about **4.1 BLS-using transactions per million**, all running the same map-and-pairing routine inside one bridge.

Pectra shipped seven general-purpose curve operations. In this window, Ethereum's onchain BLS workload was not general-purpose at all. It was 111 bridge mints and 15 group-key rotations.
