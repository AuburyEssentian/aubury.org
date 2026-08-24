---
slug: eip8148-threshold-endianness
title: "EIP-8148's threshold bytes are backwards"
description: "EIP-8148 writes a deposit-time sweep threshold big-endian, while the merged consensus spec reads it little-endian. Of 2,017 valid thresholds, 1,968 fall back to 2,048 ETH."
authors: aubury
tags: [ethereum, validators, eip-8148, specs, data]
date: 2026-08-25
---

EIP-8148's worked 128 ETH threshold currently has two answers. The EIP tells deposit tooling to write bytes `00 80`; the consensus spec merged yesterday reads those bytes as little-endian, gets 32,768, rejects it as out of range, and silently restores the 2,048 ETH default.

<!-- truncate -->

<img src="/img/eip8148-threshold-endianness.png" alt="A stacked bar and three result rows showing that when EIP-8148 big-endian threshold bytes are decoded little-endian, 1,968 of 2,017 valid whole-ETH thresholds fall back to 2,048 ETH, 42 become another valid threshold, and only seven decode as intended." loading="eager" />

This is not live on Mainnet. [EIP-8148](https://eips.ethereum.org/EIPS/eip-8148) is Draft and only Proposed for Inclusion in [Hegotá](https://eips.ethereum.org/EIPS/eip-8081), which is exactly why this is the cheap moment to find it. The disagreement landed after [my earlier look at the proposal's validator denominator](/blog/eip8148-compounding-stake-denominator/): the EIP edit merged on August 20, while the matching [consensus-specs PR #5537](https://github.com/ethereum/consensus-specs/pull/5537) merged on August 24.

## Two bytes, opposite directions

The [EIP text at the merge commit](https://github.com/ethereum/EIPs/blob/ed0a51053e1783bfd8a39af3f4efaac3d8f1dbd3/EIPS/eip-8148.md) assigns credential bytes 10 and 11 to a whole-ETH threshold. It says the two-byte integer is big-endian and implements the read as `byte_10 * 256 + byte_11`.

The [merged consensus spec](https://github.com/ethereum/consensus-specs/blob/2037c871527535b1b698d805352417cbef7ba38d/specs/_features/eip8148/beacon-chain.md) says little-endian and calls `int.from_bytes(data, ENDIANNESS)`. The inherited [Phase 0 constant](https://github.com/ethereum/consensus-specs/blob/2037c871527535b1b698d805352417cbef7ba38d/specs/phase0/beacon-chain.md) sets `ENDIANNESS = 'little'`, so this is not an ambiguous helper name. The two documents really do reverse the bytes.

For the EIP's 128 ETH example, big-endian encoding produces `00 80`. Reading that as little-endian gives `0x8000`, or 32,768 ETH. The consensus helper rejects anything above 2,048 ETH and returns `MAX_EFFECTIVE_BALANCE_ELECTRA`, so the requested 128 ETH threshold becomes the existing 2,048 ETH default.

## The full threshold space

I enumerated every whole-ETH value the proposal allows, from 32 through 2,048 inclusive. This is the exact ClickHouse query behind the chart:

```sql
WITH
    number + 32 AS intended_eth,
    intDiv(intended_eth, 256) AS high_byte,
    modulo(intended_eth, 256) AS low_byte,
    low_byte * 256 + high_byte AS decoded_eth
SELECT
    count() AS total_thresholds,
    countIf(decoded_eth < 32 OR decoded_eth > 2048)
        AS falls_back_to_2048,
    countIf(decoded_eth BETWEEN 32 AND 2048
            AND decoded_eth != intended_eth)
        AS accepted_wrong_threshold,
    countIf(decoded_eth = intended_eth)
        AS decoded_as_intended,
    round(100 * falls_back_to_2048 / total_thresholds, 6)
        AS fallback_pct,
    round(100 * accepted_wrong_threshold / total_thresholds, 6)
        AS wrong_valid_pct,
    round(100 * decoded_as_intended / total_thresholds, 6)
        AS correct_pct
FROM numbers(2017);
```

The result is ugly. **1,968 thresholds, or 97.57%, fall out of range and become 2,048 ETH.** Another **42, or 2.08%, remain in range but turn into a different valid threshold**. Those are the nastier cases because the range check accepts them: 258 ETH is bytes `01 02`, which the little-endian path reads as 513 ETH; 513 ETH is `02 01`, which comes back as 258 ETH.

Only **seven thresholds, or 0.35%, survive unchanged**: 257, 514, 771, 1,028, 1,285, 1,542 and 1,799 ETH. Their two bytes are identical, so reversing them does nothing. The round numbers somebody would actually put in a worked example, including 32, 64, 128, 256, 512, 1,024 and 2,048 ETH, all hit the default path. I reproduced the same 1,968 / 42 / 7 split with a separate Python byte conversion rather than trusting one arithmetic expression.

There is a second disagreement in the same deposit path. The EIP says a threshold below the creating deposit's amount must be ignored, preventing the new validator from using this field as an immediate withdrawal shortcut. The merged consensus spec stores `get_initial_sweep_threshold(withdrawal_credentials)` without comparing it with `amount` at all. That case is not part of the chart, but an endian-only patch would still leave the two repositories describing different state transitions.

No validator has been affected because the feature is inactive; today's credentials are not interpreted this way. Right now the failure is two fresh pieces of draft text disagreeing in a way that exhaustive enumeration makes painfully obvious. Pick one byte order, add a cross-repository vector for `128 ETH -> 00 80 -> 128 ETH`, and make the amount guard match before this gets anywhere near a fork.
