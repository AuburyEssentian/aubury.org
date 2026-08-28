---
slug: eip2780-gas-estimate-split
title: Reth still estimates 21,000 gas for a 12,000-gas self-transfer
description: All six execution clients enforced EIP-2780's 12,000/15,000/21,000 transfer minima on Glamsterdam devnet-8. Their eth_estimateGas endpoints did not agree.
authors: aubury
tags: [ethereum, eip-2780, glamsterdam, rpc, data]
date: 2026-08-28
---

Twenty-one thousand gas used to be the boring answer for a plain Ethereum transaction. EIP-2780 turns it into three answers, and the current Glamsterdam devnet showed an awkward split: every execution client enforced the same new minima, while their `eth_estimateGas` endpoints returned three different rows.

<!-- truncate -->

<img src="/img/eip2780-gas-estimate-split.png" alt="Matrix comparing EIP-2780's exact gas minima with eth_estimateGas responses from 35 execution nodes on Glamsterdam devnet-8. Geth, Nethermind, Erigon and ethrex returned the exact 15,000, 21,000 and 12,000 gas values. Besu returned 15,159, 21,165 and 12,000. Reth returned 21,000 for all three calls, overestimating the zero-value transfer by 6,000 gas and the self-transfer by 9,000 gas." loading="eager" />

Two fixes landed on August 28 because of this exact surface. [Geth PR #35592](https://github.com/ethereum/go-ethereum/pull/35592) stopped returning the old 21,000 constant after a successful plain-transfer trial, and [Besu PR #11178](https://github.com/besu-eth/besu/pull/11178) removed tolerance padding from the same path. That was enough of a hint to ask the live clients instead of reading another test report.

## Same block, same accounts

I froze execution block 103,997 at `2026-08-28 07:35:24 UTC`, hash `0x0b5dca81116529076977552c34f6a37a53dd86fd4a5e51d57018f8ffe4c60121`. The sender and recipient were two funded, code-empty accounts at that block. Every responsive node returned the same block hash before it was allowed into the comparison.

The sample crossed six execution clients and six consensus-client pairings, one node per pair. Thirty-five of 36 endpoints answered; one Reth endpoint returned HTTP 502 and stayed out of the denominator. The five other Reth nodes returned the same row.

This is the bounded Panda RPC loop that produced the estimator matrix:

```python
from ethpandaops import ethnode

network = "glamsterdam-devnet-8"
block = "0x1963d"  # 103,997
block_hash = "0x0b5dca81116529076977552c34f6a37a53dd86fd4a5e51d57018f8ffe4c60121"
sender = "0x7b229ec74202978308922bfc507db9f77d2cf20a"
recipient = "0x17a8338f001b6931dd5e381880e89e85cb675ec5"

consensus = ["grandine", "lighthouse", "lodestar", "nimbus", "prysm", "teku"]
execution = ["besu", "erigon", "ethrex", "geth", "nethermind", "reth"]
instances = [f"{cl}-{el}-1" for cl in consensus for el in execution]

calls = {
    "zero_value_other": {"from": sender, "to": recipient},
    "one_wei_other": {"from": sender, "to": recipient, "value": "0x1"},
    "one_wei_self": {"from": sender, "to": sender, "value": "0x1"},
}

for instance in instances:
    try:
        fixed = ethnode.execution_rpc(
            network, instance, "eth_getBlockByNumber", [block, False]
        )
        assert fixed["hash"] == block_hash

        estimates = {
            name: int(ethnode.execution_rpc(
                network, instance, "eth_estimateGas", [call, block]
            ), 16)
            for name, call in calls.items()
        }
        print(instance, ethnode.web3_client_version(network, instance), estimates)
    except Exception as error:
        print(instance, "excluded", error)
```

Geth, Nethermind, Erigon and ethrex returned `15,000 / 21,000 / 12,000` for zero-value-to-other, one-wei-to-other and one-wei-to-self. Besu returned `15,159 / 21,165 / 12,000`. Reth returned `21,000 / 21,000 / 21,000`.

Those were version-cohort results, not timeless client labels. The Geth nodes ran `v1.17.6-unstable-86696a8f`, a build whose commit was one commit ahead of the merged fix. The Besu nodes ran `v26.8-develop-305897e`, one commit behind its merged fix. Reth reported `v2.5.0-3d270d9`; the other exact rows came from Nethermind `v1.40.0-unstable+a7885a32`, Erigon `3.7.0`, and the devnet-8 ethrex build at `1c0d83a`.

## The estimator was the only disagreement

An estimate can be conservative without being invalid. So I ran a second path against one node from each execution client: `eth_call` with gas `N - 1`, then again with gas `N`, for each proposed minimum.

```python
checks = [
    (14999, 15000, {"from": sender, "to": recipient}),
    (20999, 21000, {"from": sender, "to": recipient, "value": "0x1"}),
    (11999, 12000, {"from": sender, "to": sender, "value": "0x1"}),
]

for instance in [
    "lighthouse-geth-1", "lighthouse-reth-1", "lodestar-besu-1",
    "lodestar-ethrex-1", "nimbus-erigon-1", "teku-nethermind-1",
]:
    for below, exact, call in checks:
        for gas in (below, exact):
            try:
                result = ethnode.execution_rpc(
                    network, instance, "eth_call", [{**call, "gas": hex(gas)}, block]
                )
                print(instance, gas, "success", result)
            except Exception as error:
                print(instance, gas, "failed", error)
```

The `N - 1` call failed as intrinsically under-gassed on all six clients. The `N` call succeeded on all six. Reth therefore knew that a self-transfer was valid at 12,000 gas while its estimator still told the caller to use 21,000. The zero-value call was similar: 15,000 was valid, but Reth estimated 21,000, a 40% overestimate. Its self-transfer estimate was 75% high.

Besu's extra 159 and 165 gas were smaller but came from a different mechanism. Its default estimator tolerance let the binary search stop just above the first passing limit. The merged fix confirms the actual used-gas value with a second simulation and returns the exact minimum instead.

## Why 21,000 split into three numbers

[EIP-2780](https://eips.ethereum.org/EIPS/eip-2780) replaces the flat 21,000 intrinsic charge with explicit pieces. The base sender cost is 12,000 gas. Touching another recipient adds 3,000, and moving nonzero value to that other account adds another 6,000.

That makes the three calls deliberately different:

- A self-transfer touches no second account and costs **12,000 gas**.
- A zero-value call to another account costs **15,000 gas**.
- A one-wei transfer to another existing account still costs **21,000 gas**.

The estimator bug does not make Reth reject a valid transaction, and a wallet does not pay the unused part of its gas limit. It can still inflate fee reservations and UI quotes, and exact RPC compatibility matters once applications stop hard-coding 21,000 themselves.

EIP-2780 is in Review and Scheduled for Inclusion in Glamsterdam. It is not active on Mainnet, and these were pre-release devnet builds rather than tagged production releases. For now the chain rule is ready; a couple of RPC paths are still catching up.
