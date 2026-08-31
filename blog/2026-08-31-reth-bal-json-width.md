---
slug: reth-bal-json-width
title: Reth returned the right BAL bytes and the wrong JSON width
description: Five Glamsterdam clients agreed on one 92,543-byte block access list, but Reth trimmed 424 fixed-width JSON fields and returned a live pending list where the RPC requires null.
authors: aubury
tags: [ethereum, reth, eip-7928, block-access-lists, rpc, glamsterdam, devnet, data]
date: 2026-08-31
---

The raw block access list was boring. Besu, Erigon, Ethrex, Nethermind and Reth all returned the same 92,543 RLP bytes for one canonical Glamsterdam block, and those bytes hashed back to the header. Then I asked for decoded JSON: Reth shortened 424 fields that the API defines as exactly 32 bytes.

<!-- truncate -->

<a href="/img/reth-bal-json-width.png">
  <img src="/img/reth-bal-json-width.png" alt="Matrix of block access list RPC checks across 36 Glamsterdam endpoints. Besu, Erigon, Ethrex and Nethermind return schema-valid fixed-block JSON, identical raw RLP, null for pending and error minus 32001 for genesis. Geth exposes neither getter. Reth returns the same raw RLP but has 424 short hash32 fields in decoded JSON and returns six different live pending lists instead of null." loading="eager" />
</a>

## Freeze the block

I used execution block 120,000, not `latest`. The refined payload model maps it to canonical Gloas slot 122,801, root `0x3f09…71e9`, and execution hash `0x17d7…8096` at 2026-08-30 13:20:12 UTC. It carried 125 transactions under a 200 million gas limit.

```sql
SELECT
  slot,
  block_root,
  block_version,
  slot_start_date_time,
  builder_index,
  block_hash,
  gas_limit,
  transactions_count,
  transactions_total_bytes
FROM `glamsterdam-devnet-8`.fct_block_payload FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-30 13:15:00')
  AND slot_start_date_time <  toDateTime('2026-08-30 13:25:00')
  AND block_hash = '0x17d702888ce9f38f4e8d24f145cb53cc98a90f543980897029f21fb761df8096';
```

`fct_block FINAL` marks that root canonical. The raw signed-bid table independently returned the same slot, root, builder index, execution hash and gas limit. Finally, `eth_getBlockByNumber` returned block access list hash `0x2cf2…60cb2` and gas used `103,452,480`.

## Ask every client the same thing

The test covered six execution clients behind each of six consensus-client endpoint families, for 36 exact node endpoints. I froze the block hash first, then sent the fixed-block, pending, genesis and unknown-block controls through Panda's node RPC path.

```python
from ethpandaops import ethnode

network = "glamsterdam-devnet-8"
consensus = ["grandine", "lighthouse", "lodestar", "nimbus", "prysm", "teku"]
execution = ["besu", "erigon", "ethrex", "geth", "nethermind", "reth"]
block_hash = "0x17d702888ce9f38f4e8d24f145cb53cc98a90f543980897029f21fb761df8096"

for cl in consensus:
    for el in execution:
        node = f"{cl}-{el}-1"
        version = ethnode.web3_client_version(network, node)
        decoded = ethnode.execution_rpc(network, node, "eth_getBlockAccessList", [block_hash])
        raw = ethnode.execution_rpc(network, node, "debug_getRawBlockAccessList", [block_hash])
        pending = ethnode.execution_rpc(network, node, "eth_getBlockAccessList", ["pending"])
```

Geth returned `-32601` for both methods on all six endpoints, so 30 endpoints exposed the getters. Every one of those 30 returned 92,543 raw bytes with SHA-256 `8896866f…26bf3`. Keccak-256 of that byte string was `0x2cf2db88…60cb2`, an exact match for the block header.

Four implementations also agreed byte-for-byte on the decoded response. Besu, Erigon, Ethrex and Nethermind each returned the same 226-account JSON array on all six endpoints. Every account had the six required fields, and every storage key, read and changed value matched the [`hash32` rule](https://github.com/ethereum/execution-apis/blob/f82695cdd9ed0073a4705b6682159e828d316104/src/schemas/base-types.yaml): `0x` followed by 64 lowercase hex digits.

Reth returned the same 226 accounts in the same order, but 424 fixed-width fields were short: 45 storage keys, 80 storage reads and 299 storage values. Zero became `0x0`; a 32-byte storage key ending in `1ceb` became `0x1ceb`. Left-padding those fields to 64 hex digits made Reth's entire response exactly equal to the other four implementations.

```text
API hash32: 0x0000000000000000000000000000000000000000000000000000000000000000
Reth JSON: 0x0
```

This is a serialization split, not a block disagreement. Reth's raw endpoint returned the same RLP as its peers, and that RLP committed to the header. The deployed handler decodes the BAL and passes the internal value straight through `serde_json::to_value`; the observed storage fields came out with quantity-style leading-zero trimming instead of the fixed byte width in the [block access list schema](https://github.com/ethereum/execution-apis/blob/f82695cdd9ed0073a4705b6682159e828d316104/src/schemas/block-access-list.yaml).

## Pending is a different failure

The current [`eth_getBlockAccessList` contract](https://github.com/ethereum/execution-apis/blob/f82695cdd9ed0073a4705b6682159e828d316104/src/eth/block.yaml) gives `pending` special treatment: return `null`. Besu, Erigon, Ethrex and Nethermind did that. Reth replayed each node's local pending block instead, returning six moving lists with 158, 164, 209, 218, 229 and 231 accounts during the same probe.

That variation is not six clients disagreeing on one canonical object. Pending templates are local and keep moving, which is exactly why this getter now refuses to pretend there is one durable pending BAL. The controls were otherwise clean across the five implementations: an unknown hash returned `null`, while genesis returned resource-not-found `-32001` from both decoded and raw getters.

Fresh [Reth PR #26882](https://github.com/paradigmxyz/reth/pull/26882) adds the pending `null` branch and aligns the pre-Amsterdam error code. The measured Reth image was `reth/v2.5.0-3d270d9`; that commit dates to August 18 and predates the open PR. The PR's current diff does not touch the fixed-width JSON serialization, so I am not treating the 424-field result as fixed.

The other measured builds were Besu `7fe6bb2`, Erigon 3.7.0, Ethrex `1c0d83a`, Geth `bbb9119`, and Nethermind `f0a29b88-hpA`. These are pre-release devnet surfaces, not Mainnet RPC claims. Geth's missing getters are an availability gap in that image; they say nothing about the BAL already committed in its block header.

The block was fine. One RPC surface changed the type on the way out.
