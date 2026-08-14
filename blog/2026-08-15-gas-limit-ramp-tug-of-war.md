---
slug: gas-limit-ramp-tug-of-war
title: "Ethereum's 60M gas-limit ramp was almost a tie"
description: "During the move from a 46M to 59.9M rolling median, 97.5% of canonical blocks took the maximum allowed gas-limit step. There were 3,958 max-up blocks and 3,714 max-down blocks."
authors: aubury
tags: [ethereum, execution-layer, gas-limit, eip-1559, eip-8261, data, correction]
date: 2026-08-15
---

Ethereum's move from a 45 million to 60 million gas limit looked like a coordinated step from a distance. At block grain it was a fight. Across the 7,866 canonical blocks in the network-level ramp, **3,958 took the maximum legal step up and 3,714 took the maximum legal step down**.

That is 97.5% of blocks pulling the limit as hard as the protocol allowed, one way or the other.

<!-- truncate -->

<figure>
  <a href="/img/gas-limit-ramp-tug-of-war.png">
    <img src="/img/gas-limit-ramp-tug-of-war.png" alt="Ethereum's 60 million gas-limit ramp took 26 hours 35 minutes, compared with a 48-minute all-max-up ceiling. Of 7,866 canonical blocks, 3,958 moved the gas limit up by the maximum allowed step and 3,714 moved it down by the maximum allowed step." loading="eager" />
  </a>
  <figcaption>The line is the rolling median over 512 canonical execution blocks. The bars classify each block's gas-limit change relative to its parent.</figcaption>
</figure>

This is newly useful because [EIP-8261](https://eips.ethereum.org/EIPS/eip-8261) moved to Review on August 13, and the consensus specs [added its gas-limit schedule](https://github.com/ethereum/consensus-specs/commit/2359a5e3444635ee2fc2acdea8a759e16391af90) the next day. The mainnet config currently says `GAS_LIMIT_SCHEDULE: []`, so nothing has been scheduled and this is not active protocol policy. The proposal is an optional way for clients to share the same default target at a named epoch instead of shipping target changes through separately timed releases.

The November data is a decent picture of the coordination mess that proposal is trying to remove. It is not a test of EIP-8261; the schedule did not exist then, and operators would still be free to override it.

## Nearly every block hit an edge

A block can change its parent's gas limit by less than `parent_gas_limit / 1,024`. In practice, a client aiming far above or below the parent commonly chooses the largest valid integer step: `parent_gas_limit // 1,024 - 1`. That gives an ugly but useful signal. A maximum-up block was targeting higher, while a maximum-down block was targeting lower.

I resolved the November 20 through December 1 window to literal execution block bounds first, then pulled canonical headers from the raw table. The analysis ran locally at one row per block hash so the parent comparison stayed boring and explicit.

```python
bounds = clickhouse.query("clickhouse-refined", """
SELECT
  min(execution_payload_block_number) AS min_block_number,
  max(execution_payload_block_number) AS max_block_number
FROM mainnet.fct_block_head FINAL
WHERE slot_start_date_time >= toDateTime('2025-11-20 00:00:00')
  AND slot_start_date_time <  toDateTime('2025-12-02 00:00:00')
  AND execution_payload_block_number > 0
""")

# Resolved bounds: 23,836,545 through 23,922,066
headers = clickhouse.query("clickhouse-raw", """
SELECT block_number, block_hash, block_date_time, gas_limit
FROM default.canonical_execution_block FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 23836545 AND 23922066
ORDER BY block_number
""")

headers = headers.drop_duplicates(["block_number", "block_hash"])
headers["parent_limit"] = headers.gas_limit.shift(1)
headers["delta"] = headers.gas_limit - headers.parent_limit
headers["max_step"] = headers.parent_limit // 1024 - 1
headers["max_up"] = headers.delta == headers.max_step
headers["max_down"] = headers.delta == -headers.max_step
headers["rolling_512_median"] = headers.gas_limit.rolling(512).median()
```

The refined bound path had 85,680 canonical head rows. The raw execution table had 85,522 blocks with payloads, and a separate query against `canonical_beacon_block FINAL` returned the same 85,522 `(block_number, block_hash)` pairs. Every gas limit agreed and every adjacent transition stayed inside the EIP-1559 bound.

For the ramp clock, I used the first 512-block rolling-median crossing of 46 million and the first crossing of 59.9 million. That starts at slot 13,102,597 on November 25 at 07:19:47 UTC and ends at slot 13,110,572 on November 26 at 09:54:47 UTC: **26 hours 35 minutes across 7,865 block transitions**.

If every block had taken the maximum step up from the actual starting header, the same move would have needed 240 blocks. At one block every 12 seconds, that is a 48-minute physical ceiling, or **32.8 times faster** than the observed ramp. Empty slots would make the real wall-clock minimum a little longer; the point is the scale of the opposing pressure, not a promise that mainnet can produce 240 consecutive blocks.

The full split was 3,958 maximum-up blocks, 3,714 maximum-down blocks, 98 partial increases, and 96 flat blocks. There were no partial decreases in this interval. The difference between the two large camps was only 244 blocks, yet that thin surplus was enough to drag the rolling median from 46.0 million to 59.9 million.

This was not a smooth parameter update. It was a near-even sequence of incompatible defaults.

## What I got wrong in February

My February post, [Ethereum's gas limit doubled in three coordinated waves](/blog/2026/02/27/gas-limit-doubling/), called slot 13,097,935 on November 24 the first block above 46 million and described the final move as 22 hours. The exact canonical series does not support both claims. A block had already crossed 46 million on November 22 at 21:09:35 UTC, then the limit fell back; isolated threshold crossings are a bad clock for this ramp.

I am retracting that first-crossing attribution and the 22-hour duration. With the explicit 512-block-median rule above, the comparable 46.0-to-59.9-million move took 26 hours 35 minutes. The old post's broader phase history survives, but its clean handoff story did not describe what block producers were doing underneath.

## A schedule is boring on purpose

EIP-8261 would put epoch-and-target pairs in a shared config. At the scheduled epoch, clients that have not been manually overridden would begin aiming at the same gas limit. The block-by-block EIP-1559 bound remains, so the limit would still ramp rather than jump; the change is that the default direction stops depending on which release happened to reach a proposer first.

The current mainnet list is empty, the EIP is informational, and no future gas limit is implied by the spec change. Even with a populated schedule, local overrides could recreate the same tug-of-war. Those caveats matter because a config field is not consensus and a Review EIP is not an activation.

Still, the old ramp makes the failure mode painfully concrete. Ethereum did not step from 45 million to 60 million. It argued one block at a time.
