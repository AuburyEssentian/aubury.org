---
slug: green-receipt-failed-calls
title: "A green Ethereum receipt can hide 600 failed calls"
description: "In 14 days, 288,119 successful mainnet transactions contained 1.23 million failed child calls. One status bit cannot describe everything that happened inside."
authors: aubury
tags: [ethereum, evm, transactions, receipts, eip-8141, data]
date: 2026-08-15
---

Ethereum's green receipt is a blunt answer to a messy question. Across 14 complete days, **288,119 transactions returned success even though at least one child call errored**. Those transactions contained **1,225,260 failed child calls** between them, or roughly one mixed result for every 115 successful transactions.

<!-- truncate -->

<figure>
  <a href="/img/green-receipt-failed-calls.png">
    <img src="/img/green-receipt-failed-calls.png" alt="Over 14 complete mainnet days, 288,119 successful transactions contained 1,225,260 failed child calls. The daily share ranged from 0.58 to 1.34 percent, with a 0.869 percent overall share." loading="eager" />
  </a>
  <figcaption>"Successful" means the root transaction trace had no error. A failed child call has a nonempty error on a non-root trace.</figcaption>
</figure>

That is newly relevant because of [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141), the draft Frame Transaction proposal. An [August 14 edit](https://github.com/ethereum/EIPs/commit/3aa076e336555abc91ff3c467b1d817685523e7c) added one unusually useful sentence: its receipt carries no transaction-level status, only a status for each explicit frame. Any interface that wants one answer has to derive it.

The draft is not describing today's nested EVM calls. Its frames are explicit top-level operations with their own execution modes and optional atomic grouping. Still, current traces are a good warning against inventing one universal color. Ethereum already produces plenty of transactions where "the transaction succeeded" and "every operation inside succeeded" are different statements.

## One root, many answers

I froze the 14 complete UTC days from July 31 through August 13. Raw canonical execution blocks and a separate refined block-number path agreed on **100,440 unique blocks**, from **25,649,111 through 25,749,550**.

The trace table uses `trace_address = NULL` for the transaction root. I reduced every `(block, transaction, trace_address)` to its latest stored row, then counted a transaction as mixed only when the root had no error and at least one non-root trace did. The query ran once per day's literal block range and the daily results were summed locally.

```python
for day, lo, hi in daily_block_bounds:
    row = clickhouse.query("clickhouse-raw", f"""
    WITH per_path AS (
      SELECT
        block_number,
        transaction_hash,
        trace_address,
        argMax(error, updated_date_time) AS latest_error,
        count() AS stored_copies
      FROM default.canonical_execution_traces FINAL
      WHERE meta_network_name = 'mainnet'
        AND block_number BETWEEN {lo} AND {hi}
      GROUP BY block_number, transaction_hash, trace_address
    ), per_tx AS (
      SELECT
        block_number,
        transaction_hash,
        count() AS frame_rows,
        sum(stored_copies) AS stored_rows,
        countIf(trace_address IS NULL) AS root_rows,
        countIf(
          trace_address IS NULL
          AND ifNull(latest_error, '') != ''
        ) AS root_error_rows,
        countIf(
          trace_address IS NOT NULL
          AND ifNull(latest_error, '') != ''
        ) AS child_error_rows
      FROM per_path
      GROUP BY block_number, transaction_hash
    )
    SELECT
      count() AS traced_transactions,
      countIf(root_rows != 1) AS bad_root_grain,
      countIf(root_error_rows = 1) AS root_failed_transactions,
      countIf(root_error_rows = 0) AS root_success_transactions,
      countIf(
        root_error_rows = 0 AND child_error_rows > 0
      ) AS mixed_success_transactions,
      sumIf(
        child_error_rows, root_error_rows = 0
      ) AS failed_child_frames_inside_success,
      sum(frame_rows) AS semantic_frames,
      sum(stored_rows) AS stored_trace_rows
    FROM per_tx
    """)
```

The grain checks were clean. All **33,454,183 transactions** had exactly one root trace, and `FINAL` left **207,977,436 stored rows for 207,977,436 semantic frame paths**. A separate query against `canonical_execution_transaction FINAL` returned the same 33,454,183 unique transaction hashes, split into **33,153,087 successes and 301,096 failures**. Those numbers matched the trace-root classification exactly.

```sql
SELECT
  count() AS stored_rows,
  uniqExact(transaction_hash) AS unique_transactions,
  countIf(success) AS success_rows,
  countIf(NOT success) AS failed_rows
FROM default.canonical_execution_transaction FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25649111 AND 25749550;

-- stored_rows = unique_transactions = 33,454,183
-- success_rows = 33,153,087
-- failed_rows = 301,096
```

The mixed-success share was **0.869056%** over the full window. It never disappeared on a quiet day: the daily count ranged from 16,695 to 24,141 transactions, while the daily share ranged from 0.5768% to 1.3421%. A mixed transaction had two failed child calls at the median, 19 at p95, 31 at p99, and 600 at the maximum.

That maximum is not a rounding artifact. [Transaction `0x8a82…27888`](https://eth.blockscout.com/tx/0x8a82daa0dd8a58f2cc0e44aef46b3c719af1c4061ee3368b4a5d3c0006027888) in block 25,665,970 had 1,201 semantic trace frames: one clean root and 600 child frames marked `Reverted`. A public JSON-RPC receipt returned `status = 0x1`, while Blockscout independently reports both `success` and `has_error_in_internal_transactions = true` for the same hash.

## Green is not wrong. It is narrow.

Today's receipt bit answers whether the root transaction reverted. A contract can make a child call, receive a failure, and keep going. That may be deliberate probing, best-effort batching, fallback logic, or something genuinely broken; the trace alone does not tell me which. Painting the whole transaction red would be just as misleading as pretending every child worked.

EIP-8141 makes the ambiguity more visible because its explicit frames can have different statuses in one receipt, including a separate code for frames skipped after an atomic-batch failure. A wallet or explorer can still show one badge, but that badge becomes product policy: all frames succeeded, some frames succeeded, the payment frame succeeded, or whatever rule the interface chooses. The protocol receipt will not settle that argument for it.

The current call-trace numbers are not a forecast for Frame Transactions, and EIP-8141 is still a draft with no mainnet activation. They do show why the draft should resist squeezing several outcomes back into one pretend fact. Green means the root survived. It never meant every call did.
