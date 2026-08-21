---
slug: eip-7923-memory-expansion-gas-backcast
title: "EIP-7923 cuts 95% of memory-expansion gas on today's execution paths"
description: "Holding historical paths fixed, EIP-7923 cuts memory-expansion gas by at least 95% across 34.08 million transactions, but only 0.323% of total gas."
authors: aubury
tags: [ethereum, eip-7923, hegota, data]
date: 2026-08-21
---

EIP-7923 sounded like a repricing for pathological memory users. Then I ran its 100-gas page charge over 34.08 million recent mainnet transactions, holding the historical execution paths fixed. On those paths, it nearly deletes the charge it replaces: no more than 0.52 billion gas instead of 10.35 billion.

That 95% headline is real and a little misleading. Memory expansion was only 0.340% of all transaction gas in the sample, so the minimum fixed-path saving is 0.323% of historical transaction gas. The first free 4 KiB page does most of the work.

<!-- truncate -->

![Across 34.08 million mainnet transactions, current memory expansion used 10.35 billion gas. A conservative EIP-7923 backcast costs at most 0.52 billion, at least 95% lower but only 0.323% of all transaction gas. Frames whose historical extent fit in one 4 KiB page account for 5.78 billion of the current charge and become free.](/img/eip-7923-memory-expansion-gas-backcast.png)

[EIP-7923](https://eips.ethereum.org/EIPS/eip-7923) was added to Hegotá's [Proposed for Inclusion list](https://github.com/ethereum/EIPs/commit/4e203d1911dc7728bf6edd548f545e120eb6675e) on August 20. That does not mean it is scheduled or live. The EIP is still a Draft, and the numbers below describe the current text rather than a locked fork rule.

## The old high-water mark versus touched pages

Today's memory-expansion charge follows `3 × words + floor(words² / 512)`, where `words` is the largest 32-byte memory extent reached inside a call frame. The current execution spec implements that [linear-plus-quadratic formula directly](https://github.com/ethereum/execution-specs/blob/3d473e865a6ff78321e8b7b015b0e9a4bb8da892/src/ethereum/forks/osaka/vm/gas.py#L248-L268).

EIP-7923 throws both terms away. It charges 100 gas when an instruction first touches a 4 KiB page inside a message call, except page zero is free. `MLOAD`, `MSTORE`, and the other memory instructions keep their base gas. This is a change to memory expansion, not free memory opcodes.

The Xatu aggregate stores the current expansion gas at call-frame grain, but it does not store the exact set of pages each instruction touched. I inverted the current formula to recover each frame's historical high-water mark, converted that extent into 4 KiB pages, then deliberately priced every page below it. That last step is pessimistic: a jump from page zero to page ten only touches two pages under the proposal, while my backcast charges all ten.

So 0.52 billion is an upper bound on the fixed-path proposed charge, and the 9.83 billion gas reduction is a lower bound on that same backcast. It is not a promise about fork execution.

Here is the aggregate query I ran over canonical execution blocks 25,426,767 through 25,527,154, covering June 30 through July 13 UTC:

```sql
WITH frame_base AS (
    SELECT
        transaction_hash,
        memory_expansion_gas AS old_memory_gas,
        toUInt64(greatest(0, floor(
            (sqrt(2359296.0 + 2048.0 * toFloat64(memory_expansion_gas))
             - 1536.0) / 2.0
        ))) AS root_words
    FROM default.canonical_execution_transaction_structlog_agg FINAL
    WHERE meta_network_name = 'mainnet'
      AND block_number BETWEEN 25426767 AND 25527154
      AND operation = ''  -- one summary row per call frame
), frame_words AS (
    SELECT
        transaction_hash,
        old_memory_gas,
        if(
            3 * (root_words + 1)
              + intDiv((root_words + 1) * (root_words + 1), 512)
              <= old_memory_gas,
            root_words + 1,
            root_words
        ) AS historical_max_words
    FROM frame_base
), priced_frames AS (
    SELECT
        transaction_hash,
        old_memory_gas,
        intDiv(historical_max_words + 127, 128) AS extent_pages,
        toUInt64(
            100 * greatest(
                toInt64(intDiv(historical_max_words + 127, 128)) - 1,
                0
            )
        ) AS conservative_page_gas
    FROM frame_words
)
SELECT
    uniqExact(transaction_hash) AS transactions,
    count() AS call_frames,
    sum(old_memory_gas) AS current_memory_gas,
    sum(conservative_page_gas) AS eip7923_upper_bound,
    toInt64(sum(old_memory_gas))
      - toInt64(sum(conservative_page_gas)) AS minimum_gas_saved
FROM priced_frames;
```

The inverse has a one-word correction because the old formula contains an integer floor. I checked the reconstructed word count by feeding it back into the old formula on every one of the 229,692,023 frame summaries. There were zero failures.

The result is blunt:

- Current memory-expansion gas: `10,348,751,050`.
- Conservative EIP-7923 upper bound: `517,021,800`.
- Minimum saved: `9,831,729,250`, or `95.004%` of the current expansion charge.
- Total transaction gas in the same blocks: `3,046,165,286,515`, making the minimum saving `0.3228%` of all transaction gas.
- At least `15,952,769` of `34,076,118` transactions, or `46.82%`, have a lower fixed-path charge even under the conservative page bound. Some transactions tied under that bound may also be cheaper; none became more expensive in this backcast.

## Page zero eats the quadratic story

There were 183.68 million frames with a nonzero memory-expansion charge. Of those, 181.46 million, or 98.79%, never crossed the first 4 KiB page in the historical execution. They paid 5.78 billion gas under the current formula and pay zero expansion gas under EIP-7923.

The long tail still matters. Just 42,107 frames reached a historical extent of 17 pages or more, yet they contributed 2.26 billion of the current 10.35 billion gas. Even after I overcharged every intervening page, their proposed total was at most 134.55 million. Removing the quadratic term cuts the ugly tail; making page zero free wipes out the ordinary case.

That is why "linear instead of quadratic" is not the useful mental model for this workload. Most frames never got far enough for the shape of the curve to be interesting. The free first page is the big change.

## The totals agree, but this is not a replay

I checked the final day through three paths. The raw frame summaries contained 696,555,051 memory-expansion gas. Summing the raw per-opcode rows produced exactly 696,555,051, and the refined `mainnet.int_transaction_call_frame_opcode_gas FINAL` table produced the same number again. The 17,359,541 summary rows on that day also matched 17,359,541 unique `(block_number, transaction_hash, call_frame_id)` keys.

The date bounds came from `mainnet.int_execution_block_by_date FINAL`; `mainnet.fct_block FINAL` independently returned the same 100,388 canonical blocks. The structlog aggregate currently ends at block 25,531,362 on July 14, so I used the latest 14 complete UTC days rather than pretending this was August telemetry. Memory pricing did not change during the gap, but the cutoff matters if anyone tries to reproduce the sample.

There is a harder boundary too. I repriced the execution paths recorded under today's rules. I did not re-execute the transactions with sparse memory, the proposal's 64 MiB transaction-wide cap, or its 32-bit address restriction. Any gas repricing can change `GAS`-sensitive branches, EIP-150 forwarding, child-call outcomes, and later control flow, even before an old transaction runs out of gas. Actual fork execution can diverge in either direction, so this is not a fork simulator and it says nothing about client runtime.

The safe result is narrower. For the paths mainnet executed in this 14-day sample, the EIP-7923 backcast removes at least 95% of memory-expansion gas. That sounds enormous until you put the charge back inside the transaction: the sample-wide share is about one third of one percent of historical transaction gas.
