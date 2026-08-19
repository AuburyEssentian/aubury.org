---
slug: eip-8374-revert-warmth
title: "USDC eats 80% of EIP-8374's backcast"
description: "A 14-day backcast of draft EIP-8374 found 169,495 verified cold address re-accesses after reverted frames. 80.3% hit USDC's FiatTokenV2_2 implementation, for a 423.7 million gas address-only lower bound."
authors: aubury
tags: [ethereum, evm, gas, eip-8374, usdc, xatu]
date: 2026-08-19
---

EIP-8374 looks like bookkeeping: stop deleting warm-access entries when an inner call reverts. Across 14 complete mainnet days, that one rule would have turned at least **169,495 later account accesses from cold to warm**. The funny part is where they landed. **136,127 of them, or 80.3%, were calls into the same USDC `FiatTokenV2_2` implementation.**

This is not a chain-wide gas miracle. The verified address-only saving is **423,737,500 gas**, just 0.0139% of the gas used in the window. It does expose a real execution shape hiding behind proxy calls: an inner frame touches an implementation and reverts, then a surviving frame reaches the same implementation and pays the cold surcharge again.

<!-- truncate -->

<img src="/img/eip-8374-revert-warmth.png" alt="Dark stacked bar chart of 169,495 verified cold address re-accesses from June 30 through July 13, 2026. USDC's FiatTokenV2_2 implementation accounts for 136,127, or 80.3 percent. The chart labels 423.7 million gas as an address-only lower bound and excludes storage keys and ambiguous or unmatched call groups." loading="eager" />

## The rule is stranger than it sounds

[EIP-2929](https://eips.ethereum.org/EIPS/eip-2929) charges 2,600 gas for the first account access in a transaction and 100 gas after the address is warm. It also says the access sets roll back with a failed scope. State changes have to revert, of course, but the client's cache does not forget the bytes it just loaded.

[Draft EIP-8374 at commit `6c39b7f`](https://github.com/ethereum/EIPs/blob/6c39b7f74eaf2fe2b7f678a0da8441822bcad007/EIPS/eip-8374.md) makes the two access sets append-only for the transaction. Once a reverted child has loaded an address or storage key, a later access stays warm. The [proposal PR](https://github.com/ethereum/EIPs/pull/12128) is open; this is not merged, scheduled, or live on mainnet.

There is one easy counting trap here. If frame A calls frame B and B reverts, B's address was accessed by A before B's failed scope began. That address remains warm today. Only addresses touched *inside* B, including B's subcalls, lose their warmth when B rolls back.

I handled that boundary from the trace path rather than treating every errored row as discarded. A target counted as reverted only when a strict ancestor path had an error. A later access had to sit outside every errored ancestor, and the target could not have appeared earlier in a surviving scope.

## The trace reduction

The structlog aggregate was complete through July 13, so I froze 14 complete UTC days from June 30 through July 13. That window contains **100,388 canonical blocks and 34,076,118 transactions**. I ran the reduction one day at a time over `canonical_execution_traces FINAL` and kept one row per transaction and target address:

```sql
WITH grouped AS (
  SELECT
    block_number,
    transaction_hash,
    arraySort(x -> x.1, groupArray((
      internal_index,
      ifNull(trace_address, ''),
      lower(ifNull(action_to, '')),
      toUInt8(error IS NOT NULL),
      lower(action_call_type)
    ))) AS events,
    arrayMap(e -> e.2, arrayFilter(e -> e.4 = 1, events)) AS error_paths
  FROM default.canonical_execution_traces FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN {day_min_block} AND {day_max_block}
  GROUP BY block_number, transaction_hash
  HAVING has(error_paths, '') = 0
     AND length(error_paths) > 0
), targets AS (
  SELECT
    block_number,
    transaction_hash,
    events,
    error_paths,
    arrayDistinct(arrayMap(d -> d.3, arrayFilter(d ->
      d.3 != ''
      AND arrayExists(
        ep -> startsWith(d.2, concat(ep, '_')),
        error_paths
      ),
      events
    ))) AS discarded_targets
  FROM grouped
), expanded AS (
  SELECT block_number, transaction_hash, events, error_paths, target_address
  FROM targets
  ARRAY JOIN discarded_targets AS target_address
), qualified AS (
  SELECT
    block_number,
    transaction_hash,
    target_address,
    arrayMin(arrayMap(d -> if(
      d.3 = target_address
      AND arrayExists(
        ep -> startsWith(d.2, concat(ep, '_')),
        error_paths
      ),
      d.1,
      toUInt32(4294967295)
    ), events)) AS first_discarded_index,
    arrayFirst(p ->
      p.3 = target_address
      AND NOT arrayExists(
        ep -> startsWith(p.2, concat(ep, '_')),
        error_paths
      ),
      events
    ) AS first_persistent_event
  FROM expanded
  WHERE arrayExists(p ->
    p.3 = target_address
    AND NOT arrayExists(
      ep -> startsWith(p.2, concat(ep, '_')),
      error_paths
    ),
    events
  )
)
SELECT
  block_number,
  transaction_hash,
  target_address,
  first_discarded_index,
  first_persistent_event.1 AS later_internal_index,
  first_persistent_event.5 AS later_call_type
FROM qualified
WHERE first_discarded_index < later_internal_index;
```

That produced **337,319 trace candidates**. A trace candidate says the call-tree order is compatible with the EIP, but it does not prove the later opcode paid cold gas. Access lists and earlier non-call opcodes can warm an address without leaving the same trace shape.

For the hard check, I matched the later trace to `canonical_execution_transaction_structlog_agg FINAL`. The trace's one-based `internal_index` matched the structlog's zero-based `call_frame_id` after subtracting one, but I also required the exact target address to match. I then moved to the parent frame and selected its `CALL`, `STATICCALL`, `DELEGATECALL`, or `CALLCODE` aggregate.

The exact filter inside the executed ClickHouse query was deliberately harsh:

```sql
arrayFirst(x ->
  x.1 = c.later_internal_index - 1
  AND x.3 = ''
  AND x.6 = c.target_address,
  a.opcode_events
) AS child_summary,
arrayFirst(x ->
  x.1 = child_summary.2
  AND x.3 = c.later_opcode,
  a.opcode_events
) AS parent_opcode_row

-- Kept in the local reduction only when:
parent_opcode_row.4 > 0
AND parent_opcode_row.5 = parent_opcode_row.4
```

If a parent executed three `DELEGATECALL`s and only one was cold, I threw the candidate away because the aggregate could not identify which child paid it. I also discarded exact frame IDs whose target address did not match. The funnel ended with 169,495 verified transaction-target pairs in 157,906 transactions. Another 17,608 matched pairs were definitely warm, 44,269 had mixed call groups, and 105,947 lacked an exact usable frame/target match.

This is why I call 423.7 million gas a lower bound. Each verified cold call would move from 2,600 gas to 100, saving exactly 2,500 gas. The total is `169,495 × 2,500`; storage-key savings from `SLOAD` and `SSTORE` are absent because this dataset does not expose the keys at the required chronological grain.

## One six-frame transaction explains the blue bars

[Transaction `0x239e...3697`](https://etherscan.io/tx/0x239efc8304cf736f761be2f001e28ae48dcce8f6ce0670196dfdd7512cea3697) is the cleanest example I found. Its successful trace has a root plus five child frames:

1. A contract makes a `STATICCALL` to the USDC proxy.
2. The proxy uses `DELEGATECALL` to reach [`0x4350...02dd`](https://etherscan.io/address/0x43506849d7c04f9138d1a2050bbf3a0c054402dd), the verified `FiatTokenV2_2` implementation.
3. That branch reverts.
4. The surviving caller later uses `CALL` on the same USDC proxy.
5. The proxy delegates to `0x4350...02dd` again and succeeds.

The proxy itself is not the counted address. Its first `STATICCALL` target was warmed in the surviving parent before the reverted scope began. The implementation was reached from inside that failed proxy frame, so current EIP-2929 semantics rolled its warmth back.

The structlog check is blunt: the parent of the later implementation frame executed one `DELEGATECALL`, its gas entry was 2,600, and `cold_access_count` was one. Under EIP-8374 that second implementation access would cost 100 gas instead. No contract label or inferred selector is needed to make the accounting work.

That exact proxy pattern repeats a lot. The `FiatTokenV2_2` address accounts for **136,127 of 169,495 verified re-accesses** and appears in the same number of transactions. The next address has 8,047. Every other address combined contributes 33,368.

## Small total, sharp clue

Only 0.46% of transactions in the window contained one of these verified address re-accesses, and 95% of affected transactions had exactly one. Even the full 423.7 million gas lower bound is a rounding error next to 3.046 trillion gas used over the 14 days.

The concentration is still useful. EIP-8374 is framed as a cleaner match between gas accounting and client cache behavior; the backcast says its visible account-level discount is not spread evenly across exotic contracts. In this window it was mostly one mundane proxy implementation getting loaded, forgotten by the access journal, and loaded again. The EIP is tiny at chain scale, but the reason it saves gas is sitting in plain sight.
