---
slug: withdrawal-request-zero-exits
title: Withdrawal requests can say zero and still pay out 23,812 ETH
description: In 31 days of EIP-7002 withdrawal requests, full exits encoded amount=0. The same validators later produced 23,812 ETH of canonical withdrawals.
authors: aubury
tags: [ethereum, staking, electra, withdrawals, data]
date: 2026-06-27
---

The new withdrawal-request table has a rude little footgun: `amount = 0` does not mean "withdraw zero ETH." It means "full exit this validator."

That matters because a naive sum over `canonical_beacon_block_execution_request_withdrawal.amount` quietly drops the exits. In the May 27 to June 26 mainnet window I checked, those zero-amount full-exit requests showed up as **0 ETH** on the request side, while the same validators later produced **23,812 ETH** of canonical withdrawals within seven days.

<!-- truncate -->

<img src="/img/withdrawal-request-zero-exits.png" alt="Dark horizontal bar chart comparing withdrawal request amounts with later canonical withdrawals for full-exit, partial-only, and mixed EIP-7002 withdrawal-request validators." loading="eager" />

This is not a data bug. Electra defines `FULL_EXIT_REQUEST_AMOUNT = uint64(0)`, with the description "Withdrawal amount used to signal a full validator exit." The state transition branches on that value before it ever treats the request as a partial withdrawal:

```python
amount = withdrawal_request.amount
is_full_exit_request = amount == FULL_EXIT_REQUEST_AMOUNT

if is_full_exit_request:
    # Only exit validator if it has no pending withdrawals in the queue
    if pending_balance_to_withdraw == 0:
        initiate_validator_exit(state, index)
    return
```

Positive amounts are a different path. They only work for compounding withdrawal credentials, they get capped by the validator's excess balance over 32 ETH plus anything already pending, and they enter the pending partial withdrawal queue. So even for positive rows, `amount` is closer to "requested cap" than "ETH definitely paid in this block."

Here is the request-side cut I used first. Amounts are stored in gwei, so the query divides by `1e9` only after separating the zero rows from partial requests.

```sql
SELECT
  multiIf(
    amount = 0, 'full_exit_0',
    amount < 32000000000, '<32',
    amount < 100000000000, '32-100',
    amount < 500000000000, '100-500',
    amount < 1000000000000, '500-1000',
    '1000+'
  ) AS bucket,
  count() AS requests,
  uniqExact(validator_pubkey) AS validators,
  uniqExact(source_address) AS sources,
  round(sum(toFloat64(amount)) / 1e9, 3) AS requested_eth
FROM canonical_beacon_block_execution_request_withdrawal
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-05-27 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
GROUP BY bucket
ORDER BY requested_eth DESC;
```

That query found **1,163** withdrawal request rows across **580** validators and **246** source addresses. The positive-amount rows summed to **35,407.942 ETH**. The largest partial bucket was tiny by row count but huge by ETH: **11** requests at 1,000+ ETH carried **16,396.761 ETH**.

The zero rows were the trap. There were **211** request rows with `amount = 0`, and the request-side ETH sum for them is, obviously, zero. If you stop there, you have counted a full validator exit as no money moving.

So I mapped each request pubkey to a validator index through `canonical_beacon_validators_pubkeys`, then pulled canonical withdrawal rows for those validators. The follow-through query was deliberately simple: same validator, withdrawal rows after the first request, seven-day window.

```sql
-- Request rows grouped to one line per validator.
WITH req AS (
  SELECT
    validator_pubkey,
    min(slot_start_date_time) AS first_request,
    max(slot_start_date_time) AS last_request,
    sum(toFloat64(amount)) / 1e9 AS requested_eth,
    count() AS request_count,
    countIf(amount = 0) AS full_rows,
    countIf(amount > 0) AS partial_rows
  FROM canonical_beacon_block_execution_request_withdrawal
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-05-27 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-27 00:00:00')
  GROUP BY validator_pubkey
), pk AS (
  SELECT pubkey, any(index) AS validator_index
  FROM canonical_beacon_validators_pubkeys
  WHERE meta_network_name = 'mainnet'
  GROUP BY pubkey
)
SELECT req.*, pk.validator_index
FROM req
LEFT JOIN pk ON req.validator_pubkey = pk.pubkey;

-- Then sum canonical withdrawals for those validator_index values.
SELECT
  withdrawal_validator_index AS validator_index,
  slot_start_date_time,
  toFloat64(withdrawal_amount) / 1e9 AS withdrawal_eth
FROM canonical_beacon_block_withdrawal
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-05-27 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-06-28 00:00:00')
  AND withdrawal_validator_index IN (...);
```

The full-exit-only group had **204** validators and **208** request rows. Their summed `request.amount` was **0 ETH**. Within seven days of the first request, **172** of those validators had canonical withdrawal rows totaling **23,812.441 ETH**. In the June 26 balance snapshot, **184** of the 204 were already `withdrawal_done`, another **17** were `withdrawal_possible`, and **2** were `active_exiting`.

The partial side behaved more like the field name suggests, but still not perfectly. The partial-only group had **373** validators and **928** requests, with **34,592.658 ETH** requested and **29,891.108 ETH** withdrawn within seven days. Some of the gap is just timing: recent requests, queue processing, insufficient excess balance, or already-pending partials. The spec uses `min(balance - 32 ETH - pending_balance_to_withdraw, amount)`, so over-asking is allowed to collapse into a smaller pending withdrawal.

The clean mental model is this: `canonical_beacon_block_execution_request_withdrawal` is an execution-layer request table, not a payout ledger. For positive rows, `amount` is a requested partial withdrawal amount in gwei. For zero rows, it is a sentinel that asks the consensus layer to initiate a full exit.

Do not sum it and call the result ETH withdrawn.
