---
slug: orphan-hash-rpc-client-split
title: "A hash lookup came back with another hash"
description: "Across 21 orphaned Gloas payloads and 36 execution endpoints, Erigon returned canonical siblings while ethrex's count method ignored the requested hash."
authors: aubury
tags: [ethereum, gloas, execution-clients, rpc, data]
date: 2026-08-29
---

An exact hash lookup has one embarrassingly simple invariant: if it returns a block, the `hash` field should be the hash you asked for. On Platåberget this week, Erigon broke that invariant in all 124 non-null replies; the other two calls returned null.

The other clients did not converge on one answer either. Besu, Nethermind, and ethrex could still return most or all of the orphaned blocks. Geth and Reth returned `null`. Ethrex returned the right block, then gave me the canonical sibling's transaction count when I asked about the same hash.

<!-- truncate -->

![Result matrix for block-by-hash and transaction-count-by-hash calls across Besu, Nethermind, ethrex, Erigon, Geth, and Reth. Erigon returned canonical sibling blocks; ethrex returned sibling transaction counts.](/img/orphan-hash-rpc-split.png)

## Freezing the orphan set

I used one complete UTC day rather than chasing whatever happened to be near the head. Platåberget's refined block table had 22 orphaned beacon roots on August 28. One carried a 64-byte NUL sentinel instead of a printable execution hash, leaving 21 blocks that could actually be sent to JSON-RPC.

That representation detail matters. Comparing the field with a hex-encoded zero hash did not remove the raw NUL value, so the final query enforces the serialized shape instead:

```python
from ethpandaops import clickhouse

orphans = clickhouse.query("clickhouse-refined", """
SELECT
    slot,
    slot_start_date_time,
    block_root,
    execution_payload_block_hash AS block_hash
FROM `glamsterdam-devnet-8`.fct_block FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-28 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-29 00:00:00')
  AND status = 'orphaned'
  AND startsWith(execution_payload_block_hash, '0x')
  AND length(execution_payload_block_hash) = 66
ORDER BY slot
""")
```

The query returned 21 rows. I froze the ordered `(slot, block_hash)` ledger before calling any nodes; its SHA-256 is `34f586ceb67fb37be926f07e6522da1c644bac125d7680fb742b076bac7aba22`.

I then called six instances of each execution client, one behind each consensus-client pairing. That gave 36 endpoints and 756 calls per method:

```python
from ethpandaops import ethnode

consensus = ["grandine", "lighthouse", "lodestar", "nimbus", "prysm", "teku"]
execution = ["besu", "erigon", "ethrex", "geth", "nethermind", "reth"]

for cl in consensus:
    for el in execution:
        instance = f"{cl}-{el}-1"
        for block_hash in orphans.block_hash:
            block = ethnode.execution_rpc(
                "glamsterdam-devnet-8",
                instance,
                "eth_getBlockByHash",
                [block_hash, False],
            )
            count = ethnode.execution_rpc(
                "glamsterdam-devnet-8",
                instance,
                "eth_getBlockTransactionCountByHash",
                [block_hash],
            )
```

The classification was deliberately dumb. A block reply was `exact` only when `reply["hash"] == requested_hash`; `null` stayed null; every other non-null reply was wrong. The [Execution API](https://ethereum.github.io/execution-apis/api/methods/eth_getBlockByHash) says this method returns information about a block *by hash*, while its [count companion](https://ethereum.github.io/execution-apis/api/methods/eth_getBlockTransactionCountByHash) returns the transaction count for the block matching that hash.

## Six clients, four answers

Each client had 126 calls to each method. A null is not automatically a bug because clients can prune or decline to retain a non-canonical block. A successful response carrying a different hash is the bad case.

- `Besu`: block 121 exact, 5 null; count 121 exact, 5 null.
- `Nethermind`: block 123 exact, 3 null; count 123 exact, 3 null.
- `ethrex`: block 126 exact; 126 canonical-sibling counts.
- `Erigon`: 124 sibling blocks, 2 null; 124 sibling counts, 2 null.
- `Geth`: 126 null for both methods.
- `Reth`: 126 null for both methods.

The exact replies were not merely three clients returning plausible objects. For every requested hash, the available Besu, Nethermind, and ethrex responses agreed on one header and one ordered transaction list. A canonical control block also resolved exactly on all 36 endpoints.

Erigon's wrong replies had a cleaner fingerprint. In all 124 non-null cases, the returned hash exactly matched `eth_getBlockByNumber` at the orphan's execution height. It had silently switched from the requested orphan to the canonical sibling.

Ethrex split the mistake across two methods. Its block lookup returned the requested hash and body in all 126 calls. Its transaction-count lookup matched the canonical sibling's count in all 126 calls and matched the requested block's count in none of them.

Slot [105088](https://dora.plataberget.ethpandaops.io/slot/105088) is a compact example. The orphaned payload hash was `0x83e454128fc8bc937313d46165dc0f00b0d9bc64eb972d98c24ff5a55215fc55`, and the exact block held 146 transactions. Ethrex returned that block but reported 69 transactions; 69 was the count in canonical sibling `0x9424a9ffa0b50b58e363889b69163fa46e9408ac07a95dced6c13a108e995c64`. Erigon returned that 69-transaction sibling as the answer to the original hash lookup.

Dora independently labels the beacon block orphaned and shows the same payload hash and 146 transactions. The later [slot 108992](https://dora.plataberget.ethpandaops.io/slot/108992) repeated the shape with a 141-transaction orphan and a 210-transaction canonical sibling.

## The adjacent fix that missed the count method

The ethrex image was unusually helpful: it identified itself as commit [`1c0d83a`](https://github.com/lambdaclass/ethrex/commit/1c0d83a91d79972f8df24cdeafa902afbbab7145), committed on August 27. That commit fixed `eth_getBlockByHash` after the old handler resolved `hash → number → canonical block`. Its new block handler reads [directly by hash](https://github.com/lambdaclass/ethrex/blob/1c0d83a91d79972f8df24cdeafa902afbbab7145/crates/networking/rpc/eth/block.rs#L92-L117), which is exactly what the live responses showed.

The neighbouring count handler still [resolves the hash to a number and reads the body by number](https://github.com/lambdaclass/ethrex/blob/1c0d83a91d79972f8df24cdeafa902afbbab7145/crates/networking/rpc/eth/block.rs#L121-L150). That is not an inferred release story; it is the current source path, and its output matched the canonical sibling 126 times out of 126.

Erigon has the same bug class documented in [issue #23539](https://github.com/erigontech/erigon/issues/23539). Once a height is covered by canonical snapshot files, an exact-hash read can fall through to a positional height read and return the canonical block. [PR #23590](https://github.com/erigontech/erigon/pull/23590) adds the missing hash comparison and a database fallback. The live `3.7.0` behavior is compatible with that report, though I did not trace the deployed binary to one exact source commit.

Reth failed differently. Its current image returned null for the entire orphan cohort. A fresh [Reth PR](https://github.com/paradigmxyz/reth/pull/26876) now checks retained in-memory fork blocks when the canonical provider misses a hash, specifically to support Gloas payload-envelope reconstruction. The fix was still open when I ran the probe, so this is a pre-fix measurement, not evidence that the patch failed.

## Why Gloas keeps finding this stuff

Under ePBS, the consensus client may need to reconstruct an execution payload envelope from an exact fork payload hash. The ethrex fix records 54 `execution block hash mismatch` failures in 12 hours on one Prysm node and describes a one-envelope miss turning into a minutes-long stale-head episode. Reth's new lookup path exists for the same reason: Gloas moved retained fork payloads from sleepy database trivia into a recovery path that nodes actually exercise.

This was one development network, one complete-day orphan cohort, and pre-release client builds. It says nothing about Mainnet safety, and I found no consensus or funds impact. The six consensus pairings also are not six independent implementations of each execution client; they are useful replicas showing that the behavior followed the execution client rather than one pairing.

A null can be operationally painful, but it is at least honest. Returning a valid block object whose `hash` field does not equal the requested hash is worse. Every caller now has to notice that the lookup answered a different question.
