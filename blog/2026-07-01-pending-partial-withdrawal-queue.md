---
slug: pending-partial-withdrawal-queue
title: Partial withdrawal queue positions are not validators
description: In the latest mainnet pending partial-withdrawal snapshot, 87 queue positions covered 81 validators and 1,457.9 ETH. Most rows were small, but five 128-256 ETH requests carried 65.9% of the ETH.
authors: aubury
tags: [ethereum, withdrawals, electra, staking, data]
date: 2026-07-01
---

`canonical_beacon_state_pending_partial_withdrawal` looks like a tidy queue table. It is not a validator count, and it is very much not a daily intake table. In the latest mainnet snapshot I checked, the queue had **87 positions**, **81 validators**, and **1,457.9 ETH** pending.

<!-- truncate -->

The weird part is the shape. **78 of the 87 positions were under 32 ETH**, and 21 of them were under 1 ETH. At the same time, **five positions between 128 and 256 ETH carried 961.3 ETH**, or **65.9%** of everything queued. So if you count rows, the queue looks like small partial withdrawals. If you count ETH, it is mostly a handful of much larger MaxEB-era requests.

<img src="/img/pending-partial-withdrawal-queue.png" alt="Pending partial-withdrawal queue positions and queued ETH by requested amount bucket" loading="eager" />

Here is the query for the snapshot. I resolved the latest epoch first and reused it as a literal, which keeps the query bounded on the distributed raw table.

```sql
-- First resolve the latest mainnet epoch in the snapshot table.
SELECT max(epoch) AS latest_epoch
FROM default.canonical_beacon_state_pending_partial_withdrawal
WHERE meta_network_name = 'mainnet';

-- latest_epoch = 458426
SELECT
  epoch,
  epoch_start_date_time,
  state_id,
  count() AS positions,
  uniqExact(validator_index) AS validators,
  sum(amount) / 1e9 AS queued_eth,
  min(amount) / 1e9 AS min_eth,
  quantile(0.5)(amount) / 1e9 AS p50_eth,
  max(amount) / 1e9 AS max_eth,
  min(withdrawable_epoch - epoch) AS min_wait_epochs,
  quantile(0.5)(withdrawable_epoch - epoch) AS p50_wait_epochs,
  max(withdrawable_epoch - epoch) AS max_wait_epochs
FROM default.canonical_beacon_state_pending_partial_withdrawal
WHERE meta_network_name = 'mainnet'
  AND epoch = 458426
GROUP BY epoch, epoch_start_date_time, state_id;
```

That returned epoch `458426`, state `14669632`, at **2026-06-30 22:46:47 UTC**. The smallest queued amount was **18 gwei**. The median queued amount was **3.543789 ETH**. The largest was **229.455237 ETH**. The median wait left was **115 epochs**, about **12.3 hours**, and the max was **289 epochs**, about **30.8 hours**.

The 18 gwei rows are not a typo. [Electra's withdrawal-request path](https://github.com/ethereum/consensus-specs/blob/master/specs/electra/beacon-chain.md#new-process_withdrawal_request) appends a pending partial withdrawal with the actual `to_withdraw`, not blindly with the user's requested cap. In the spec, the partial path does this:

```python
to_withdraw = min(
    state.balances[index] - MIN_ACTIVATION_BALANCE - pending_balance_to_withdraw,
    amount,
)
state.pending_partial_withdrawals.append(
    PendingPartialWithdrawal(
        validator_index=index,
        amount=to_withdraw,
        withdrawable_epoch=withdrawable_epoch,
    )
)
```

That means the queue amount is already clipped by the validator's excess balance over 32 ETH and by earlier pending partials for the same validator. A big request can become a smaller queue entry. A tiny excess balance can become an 18 gwei queue entry. Ugly, but correct.

There is another easy way to lie to yourself with this table: group the snapshot rows by day and sum them. June 30 then looks like **232,075.965 ETH** of pending partial withdrawals. The latest snapshot was only **1,457.921 ETH**. That is a **159x** inflation from treating state snapshots like event rows.

```sql
SELECT
  toDate(epoch_start_date_time) AS day,
  count() AS rows,
  uniqExact(epoch) AS epochs,
  uniqExact(position_in_queue) AS positions_seen,
  uniqExact(validator_index) AS validators_seen,
  sum(amount) / 1e9 AS snapshot_row_sum_eth
FROM default.canonical_beacon_state_pending_partial_withdrawal
WHERE meta_network_name = 'mainnet'
  AND epoch_start_date_time >= toDateTime('2026-06-30 00:00:00')
  AND epoch_start_date_time <  toDateTime('2026-07-01 00:00:00')
GROUP BY day;
```

That query returned **15,971 rows** across **214 epoch snapshots**. It saw 92 queue positions over the day, but many of those positions were the same pending entries being carried forward from one state to the next. This is a snapshot table. Use one state, or explicitly model entry and exit from the queue. Do not sum the day.

I also checked the execution request surface for the validators still in the latest queue. Mapping those 81 validator indices to pubkeys and looking back to June 17 found **197 withdrawal-request rows**, all positive amount rows, with **zero** `amount = 0` full-exit sentinel rows. The request amounts ranged from **17 gwei** to **1,000 ETH**, and the same validators had requested **2,630.4 ETH** over that window. The current queue held less than that because some entries had already processed and because the state transition clips partial withdrawals to available excess balance.

```sql
-- Pubkey mapping was resolved with mainnet.dim_validator_pubkey FINAL,
-- then the pubkeys were used as a bounded literal IN list.
SELECT
  count() AS request_rows,
  uniqExact(validator_pubkey) AS validators,
  countIf(amount = 0) AS full_exit_zero_rows,
  countIf(amount > 0) AS positive_rows,
  sum(amount) / 1e9 AS requested_eth,
  min(amount) / 1e9 AS min_request_eth,
  max(amount) / 1e9 AS max_request_eth,
  min(slot_start_date_time) AS first_request,
  max(slot_start_date_time) AS last_request
FROM default.canonical_beacon_block_execution_request_withdrawal
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-06-17 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-07-01 00:00:00')
  AND validator_pubkey IN (...current queue pubkeys...);
```

Six validators had two pending partial-withdrawal positions in the latest state. One of them had two separate **18 gwei** entries, with different withdrawable epochs. That is the part I would have missed if I had treated `validator_index` as the queue key.

The safe read is boring: this table is a **pending partial-withdrawal queue snapshot**. Its rows are positions, not validators. Its `amount` is gwei, not ETH. And across time, its rows are repeated state, not new requests.

Count the surface you mean.