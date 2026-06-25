---
slug: pending-deposit-queue-maxeb
title: The pending deposit queue is not a 32 ETH counter
description: In the latest mainnet pending-deposit snapshot, large 0x02 deposits were only 5.6% of queue positions but 60.9% of queued ETH.
authors: aubury
tags: [ethereum, staking, maxeb, electra, data]
date: 2026-06-26
---

Counting pending deposits used to be close enough to counting future validators. One queue entry, 32 ETH, one validator. That shortcut is now broken in the queue itself, not just at the deposit contract.

In the latest mainnet pending-deposit snapshot I checked, the queue had **37,334** deduped positions carrying **2.807M ETH**. By position count it still looked boring: **81.4%** of positions were exact 32 ETH deposits with `0x01` withdrawal credentials. By ETH, the story flipped. Large `0x02` compounding deposits were only **5.6%** of positions, but **60.9%** of the queued ETH.

<!-- truncate -->

<figure>
  <a href="/img/pending-deposit-queue-maxeb.png"><img src="/img/pending-deposit-queue-maxeb.png" alt="Dark two-panel horizontal bar chart comparing Ethereum pending deposit queue composition by queue positions and by queued ETH. Exact 32 ETH 0x01 deposits dominate position count, while large 0x02 deposits dominate queued ETH." loading="eager" /></a>
  <figcaption>Source: Xatu raw <code>canonical_beacon_state_pending_deposit</code>, mainnet epoch 457290, state id 14633280, 2026-06-25 21:36 UTC. Raw rows were deduped by <code>position_in_queue</code>.</figcaption>
</figure>

The table name is doing exactly what it says: this is the consensus state's `pending_deposits` queue, not the execution deposit log and not the active validator set. Electra's [`PendingDeposit`](https://github.com/ethereum/consensus-specs/blob/master/specs/electra/beacon-chain.md#pendingdeposit) container is just `pubkey`, `withdrawal_credentials`, `amount`, `signature`, and `slot`. That makes it easy to count rows. It also makes it very easy to count the wrong thing.

The raw rows were duplicated in this snapshot, so I did not use `count()` directly. The snapshot had **149,336** raw rows, but only **37,334** unique queue positions after grouping inside the latest `(epoch, state_id)` pair. Here is the query shape behind the chart:

```sql
WITH snapshot AS (
  SELECT
    max(epoch) AS epoch
  FROM canonical_beacon_state_pending_deposit
  WHERE meta_network_name = 'mainnet'
), state AS (
  SELECT state_id
  FROM canonical_beacon_state_pending_deposit
  WHERE meta_network_name = 'mainnet'
    AND epoch = (SELECT epoch FROM snapshot)
  GROUP BY state_id
  ORDER BY count() DESC
  LIMIT 1
), dedup AS (
  SELECT
    position_in_queue,
    any(pubkey) AS pubkey,
    any(withdrawal_credentials) AS withdrawal_credentials,
    any(amount) AS amount,
    any(slot) AS slot,
    count() AS raw_rows_for_position
  FROM canonical_beacon_state_pending_deposit
  WHERE meta_network_name = 'mainnet'
    AND epoch = (SELECT epoch FROM snapshot)
    AND state_id = (SELECT state_id FROM state)
  GROUP BY position_in_queue
), total AS (
  SELECT sum(amount) AS total_amount, count() AS total_positions
  FROM dedup
)
SELECT
  multiIf(
    amount = 32000000000 AND substring(withdrawal_credentials, 1, 4) = '0x01', '32 ETH / 0x01',
    amount = 32000000000 AND substring(withdrawal_credentials, 1, 4) = '0x02', '32 ETH / 0x02',
    amount = 1920000000000 AND substring(withdrawal_credentials, 1, 4) = '0x02', '1,920 ETH / 0x02',
    amount > 32000000000 AND substring(withdrawal_credentials, 1, 4) = '0x02', '>32 ETH / 0x02',
    amount < 32000000000, '<32 ETH top-ups',
    'other'
  ) AS bucket,
  count() AS positions,
  uniqExact(pubkey) AS pubkeys,
  round(sum(amount) / 1e9, 3) AS eth,
  round(100 * count() / (SELECT total_positions FROM total), 2) AS pct_positions,
  round(100 * sum(amount) / (SELECT total_amount FROM total), 2) AS pct_eth
FROM dedup
GROUP BY bucket
ORDER BY eth DESC;
```

The count-side result is why this can hide in plain sight. There were **30,402** exact-32 ETH `0x01` positions, which is **81.4%** of the queue. If a dashboard turned that into "roughly thirty-seven thousand validators waiting," it would at least have the shape of the old world.

The balance-side result is the new world. The `>32 ETH / 0x02` bucket had **1.376M ETH** in **1,930** positions. The exact-1,920 ETH bucket added another **334,080 ETH** across **174** positions. Together, those two large `0x02` buckets were **2,104** queue positions and **1.710M ETH**. That is the **5.6% of positions / 60.9% of ETH** line in the chart.

For scale, the latest daily validator-balance table had about **39.99M ETH** of active effective balance. This pending-deposit snapshot was **7.0%** of that number. I am not saying it is active stake, because it is not. I am saying a pending queue measured in pubkeys now hides millions of ETH behind a few thousand large compounding deposits.

The spec explains why this is not just a cosmetic accounting problem. Electra processes `pending_deposits` during epoch processing with two separate brakes: `MAX_PENDING_DEPOSITS_PER_EPOCH = 16`, and an activation/exit balance churn cap that tops out at **256 ETH per epoch**. A 32 ETH deposit is one small bite. A 1,920 ETH deposit is 7.5 epochs of the max activation budget if it has to be activated through that balance gate.

The front of the queue made that concrete. Before the first exact-32 ETH position, there were **28** positions carrying **48,605 ETH**. **27** of those were exact-1,800 ETH `0x02` deposits. Count them as 28 rows and you miss the point. Count the ETH and the queue suddenly looks like a balance scheduler.

The `slot` field is also a warning label. Using the queue entry's `slot` as the queued-at slot, **1.603M ETH** in the deduped snapshot sat in the 30-179 day bucket, **764k ETH** sat in the 7-29 day bucket, **381k ETH** sat in the 1-6 day bucket, and only **58k ETH** was under one day old. I am not turning that into a promised activation wait time, because the queue has protocol guards and some entries can be postponed or blocked for reasons the amount table alone does not explain. But it is enough to kill the idea that this is just today's deposit traffic.

I also checked the intake path for the same UTC day. `canonical_beacon_block_execution_request_deposit` had **945** deposit-request rows from 00:00 through the snapshot time, including **7** exact-1,920 ETH `0x02` requests. That table is not the queue, but it shows the same shape still arriving: mostly 32 ETH by count, with occasional MaxEB-sized deposits that matter much more by balance.

One caveat: the available pending-state snapshots in this raw table covered June 25, so this is a current-state post, not a trend post. The old shortcut is still the thing to update. A pending deposit position is no longer a validator-sized unit. Sometimes it is 32 ETH. Sometimes it is 1,920 ETH wearing the same row shape.
