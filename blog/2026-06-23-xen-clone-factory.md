---
slug: xen-clone-factory
title: XEN is still minting contracts by the hundred thousand
description: In seven complete UTC days, XEN-linked factories produced 62.6% of Ethereum contract-creation rows. One CoinTool batch minter made 141,671 identical 45-byte ERC-1167 proxies.
authors: aubury
tags: [ethereum, execution, xatu, contracts, data]
date: 2026-06-23
---

I opened the new contract-creation table expecting the usual factory soup: account abstraction wallets, Uniswap pools, NFT leftovers, random deployer spam. XEN was sitting in the middle of it again, quietly copying the same tiny contract over and over.

Not metaphorically tiny. Forty-five bytes.

<!-- truncate -->

<figure>
  <img src="/img/xen-clone-factory.png" alt="Stacked bar chart of Ethereum contract-creation rows from May 24 through June 22 2026, showing XEN batch minters dominating several spikes and 62.6% of Jun 16-22 rows." loading="eager" />
</figure>

The table is `canonical_execution_contracts`, one of the fresh Xatu execution-layer tables from the cryo path. It records contracts that come out of execution traces: factory, deployer, init code, runtime code, code hash, and byte length. That makes it a good place to ask a very plain question: when Ethereum creates contracts right now, what is it actually creating?

For the seven complete UTC days from June 16 through June 22, mainnet had **264,953** contract-creation rows. A single factory, `0x0de8bf93da2f7eecb3d9169422413a9bef4ef628`, produced **141,671** of them. Etherscan labels it **CoinTool: XEN Batch Minter**. Add two other XEN-labelled factories I grouped separately, `MXENFT Token` and `XENT Token`, and the XEN-linked bucket becomes **165,936 rows**, or **62.63%** of the week.

Here is the counting query in its simplest form. I resolved the complete-day block range first, then counted factory rows inside it:

```sql
SELECT
  count() AS total_creations,
  uniqExact(transaction_hash) AS creation_txs,
  countIf(n_code_bytes = 45) AS code45,
  countIf(factory = '0x0de8bf93da2f7eecb3d9169422413a9bef4ef628') AS xen_batch_minter,
  countIf(factory = '0x0000000000771a79d0fc7f3b7fe270eb4498f20b') AS mxenft_token,
  countIf(factory = '0x0a252663dbcc0b073063d6420a40319e438cfa59') AS xent_token,
  countIf(factory IN (
    '0x0de8bf93da2f7eecb3d9169422413a9bef4ef628',
    '0x0000000000771a79d0fc7f3b7fe270eb4498f20b',
    '0x0a252663dbcc0b073063d6420a40319e438cfa59'
  )) AS xen_family
FROM canonical_execution_contracts
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25326351 AND 25376588;
```

That returned **264,953** total creations, **186,416** rows with 45-byte runtime code, **141,671** from the CoinTool XEN batch minter, and **165,936** from the three XEN-linked factories combined. The 45-byte part is the tell. The CoinTool rows all had one `code_hash`, and every runtime bytecode sample matched the ERC-1167 minimal-proxy shape:

```text
363d3d373d3d3d363d73 <20-byte implementation> 5af43d82803e903d91602b57fd5bf3
```

For the CoinTool factory, the implementation address inside the proxy was the factory itself:

```text
0x363d3d373d3d3d363d73
  0de8bf93da2f7eecb3d9169422413a9bef4ef628
5af43d82803e903d91602b57fd5bf3
```

So this was not 141,671 different applications showing up. It was 141,671 identical minimal proxies pointing back to the same XEN batch-minter contract. The batch shape was also obvious at transaction level: **2,487** transactions created those proxies, with a median of **50** contracts per transaction and a max of **90**.

The raw trace table agreed after deduping. This part matters because raw execution trace rows can double-count some create actions, just like `suicide` traces needed deduping in the SELFDESTRUCT post. If I counted raw `create` rows directly, the CoinTool factory showed **158,331** rows. If I deduped by `(transaction_hash, trace_address)` or by `result_address`, it came back to **141,671**, exactly matching `canonical_execution_contracts` and the `factory` relationship rows in `canonical_execution_address_appearances`.

```sql
SELECT
  action_from,
  count() AS create_trace_rows,
  uniqExact(transaction_hash, trace_address) AS deduped_create_traces,
  uniqExact(result_address) AS unique_result_addresses,
  countIf(error IS NULL OR error = '') AS no_error,
  countIf(result_code IS NOT NULL AND length(result_code) = 92) AS result_code_45b
FROM canonical_execution_traces
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25326351 AND 25376588
  AND action_type = 'create'
  AND action_from IN (
    '0x0de8bf93da2f7eecb3d9169422413a9bef4ef628',
    '0x0000000000771a79d0fc7f3b7fe270eb4498f20b',
    '0x0a252663dbcc0b073063d6420a40319e438cfa59'
  )
GROUP BY action_from
ORDER BY create_trace_rows DESC;
```

For the CoinTool factory, that produced **158,331** raw trace rows, **141,671** deduped create traces, **141,671** unique result addresses, **0** errored creates, and **141,671** 45-byte outputs. The XENT factory had the same duplication shape: **6,880** raw rows became **5,145** deduped result addresses. The MXENFT factory did not duplicate in this sample: **19,120** raw rows and **19,120** result addresses.

This is why the chart separates XEN from "everything else" instead of treating contract creation as one clean adoption metric. Some days really are broad factory activity. June 3 and June 4 had 30-35k creations with almost no XEN in the three-address bucket. But the big late-June spikes were different. June 16 had **65,280** contract rows, and **44,700** came from the CoinTool XEN batch minter alone. June 21 had **57,607** rows; **45,982** were XEN-linked.

The mechanism is ugly but simple. XEN-style minting rewards fresh identities and batch tooling makes those identities cheap to stamp out. ERC-1167 proxies are the perfect shape for that: tiny runtime code, deterministic-looking factory behavior, lots of result addresses, almost no per-contract uniqueness. The chain still gets a new contract address and a code hash each time.

That distinction matters if you use "new contracts" as a proxy for developer activity. In this window, most of the contract-creation spike was not new protocols, new wallets, or new application surface. It was a mint factory copying the same 45-byte proxy into thousands of addresses per day.

A new contract is not always a new thing.
