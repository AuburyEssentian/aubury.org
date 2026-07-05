---
slug: rocketpool-rpl-one-way
title: "Rocket Pool's RPL event went one-way after Saturn"
description: "After Rocket Pool's Saturn 1 boundary, the decoded rpl_staked event stopped at Feb 17 while withdrawals and megapools kept moving."
authors: [aubury]
tags: [ethereum, rocketpool, staking, saturn, xatu, data]
date: 2026-07-05
---

Rocket Pool's `rpl_staked` event looks like it fell off a cliff at exactly the wrong time. The last decoded stake event in `mainnet.int_rocketpool_node_event` was **2026-02-17 23:20:23 UTC**. The first decoded megapools started about 40 minutes later, on **Feb 18**, and the withdrawal side kept moving for months.

That does not mean "nobody staked RPL after Saturn." It means the old decoded stake-event surface is a bad post-Saturn RPL-staking ledger unless you know what changed.

<!-- truncate -->

<img src="/img/rocketpool-rpl-one-way.png" alt="Dark chart showing Rocket Pool decoded RPL stake events stopping after Saturn while RPL withdrawals and megapool creations continue" loading="eager" />

[Rocket Pool's own docs](https://docs.rocketpool.net/node-staking/megapools/staking-and-claiming-rewards) put the context in plain English: Saturn 1 moved the RPL story to megapools, voter-share rewards, and a new two-step withdrawal flow. The docs also say, bluntly, that "it's not possible to stake RPL on a minipool anymore." So I went looking for the boundary in the decoded tables rather than assuming the event name still meant the same thing.

Here is the refined-table query behind the chart. I kept it to 2026 so the Saturn boundary is not buried under years of old minipool history.

```sql
WITH node AS (
  SELECT
    toStartOfMonth(event_date_time) AS month,
    sumIf(toFloat64(rpl_amount_wei) / 1e18, event_name = 'rpl_staked') AS rpl_staked,
    sumIf(toFloat64(rpl_amount_wei) / 1e18, event_name = 'rpl_withdrawn') AS rpl_withdrawn,
    countIf(event_name = 'rpl_staked') AS stake_events,
    countIf(event_name = 'rpl_withdrawn') AS withdraw_events,
    countIf(event_name = 'node_registered') AS node_registered_events,
    countIf(event_name = 'smoothing_pool_state_changed') AS smoothing_events
  FROM mainnet.int_rocketpool_node_event
  WHERE event_date_time >= toDateTime('2026-01-01 00:00:00')
    AND event_date_time <  toDateTime('2026-07-05 00:00:00')
  GROUP BY month
), mega AS (
  SELECT
    toStartOfMonth(created_date_time) AS month,
    count() AS megapools,
    uniqExact(node_operator) AS megapool_operators
  FROM mainnet.int_rocketpool_megapool
  WHERE created_date_time >= toDateTime('2026-01-01 00:00:00')
    AND created_date_time <  toDateTime('2026-07-05 00:00:00')
  GROUP BY month
)
SELECT
  coalesce(node.month, mega.month) AS month,
  round(ifNull(rpl_staked, 0), 6) AS rpl_staked,
  round(ifNull(rpl_withdrawn, 0), 6) AS rpl_withdrawn,
  ifNull(stake_events, 0) AS stake_events,
  ifNull(withdraw_events, 0) AS withdraw_events,
  ifNull(node_registered_events, 0) AS node_registered_events,
  ifNull(smoothing_events, 0) AS smoothing_events,
  ifNull(megapools, 0) AS megapools,
  ifNull(megapool_operators, 0) AS megapool_operators
FROM node FULL OUTER JOIN mega ON node.month = mega.month
ORDER BY month;
```

The split is very clean. In January and February 2026, the decoded node-event table had **373 `rpl_staked` events** totaling **282,255.371 RPL**. From Mar 1 through Jul 4, it had **zero**. Over that same post-March window it still decoded **134 `rpl_withdrawn` events** from **133 nodes**, totaling **952,795.638 RPL**, with the latest withdrawal on **Jul 4 16:54:59 UTC**.

The table was not dead. It also saw **60** node registrations and **56** smoothing-pool changes after Mar 1. The megapool table was alive too: **147** new megapools from **147** operators between Mar 1 and Jul 4, after **183** appeared in February. This is not a general Rocket Pool inactivity story. It is a specific event-surface story.

I checked the raw logs because this is exactly the kind of place where a decoded table can accidentally turn a contract migration into a fake user-behavior claim. The refined events map to two raw event signatures and two contract addresses in this 2026 window:

```sql
-- clickhouse-raw, after resolving Jan 1-Jul 4 UTC to blocks 24136053-25462598
SELECT DISTINCT
  block_number,
  log_index,
  transaction_hash,
  address,
  topic0,
  topic1,
  data
FROM default.canonical_execution_logs
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 24136053 AND 25462598
  AND (
    (address = '0xf18dc176c10ff6d8b5a17974126d43301f8eeb95'
      AND topic0 = '0x4e3bcb61bb8e63cb9ed2c46d47eeb6ae847c629e909fbb32b9d17874affb4a89')
    OR
    (address = '0xf18dc176c10ff6d8b5a17974126d43301f8eeb95'
      AND topic0 = '0x9947063f70b076145616018b82ed1dd5585e15b7ae0a0b17a8b06bec4c4c31e2')
    OR
    (address = '0xedfc7dcae43ff954577a2875a9d805874490ee3e'
      AND topic0 = '0x9947063f70b076145616018b82ed1dd5585e15b7ae0a0b17a8b06bec4c4c31e2')
  );
```

After deduping identical raw log rows, the raw path matched the refined counts: **373** stake logs through Feb 17, **81** old-contract withdrawal logs in January/February, and **134** withdrawal logs from the newer `0xedfc...ee3e` contract after Mar 1. Decoding the first 32-byte word of `data` as the RPL amount gave the same RPL totals as the refined table. A wider raw scan for the old stake topic found it only on `0xf18d...eb95`, with **0** same-signature stake logs after Mar 1.

The new contract was not quiet. From Mar 1 through Jul 4 it emitted other topics as well as withdrawals: one topic had **604** distinct logs, another had **149**, and the `rpl_withdrawn` topic had **134**. I am not going to pretend those topic hashes are self-explanatory without ABI work. The useful point is simpler: the post-Saturn contract surface changed, and the decoded `rpl_staked` event did not follow the new staking path.

There is another stale-table footgun nearby. `mainnet.fct_rocketpool_validator` was updated on Jul 5, but its newest `created_date_time` in this run was **2026-02-23 20:41:59**. It had **0** validators created after Mar 1 even while `int_rocketpool_megapool` had fresh July rows. If you are trying to count current Rocket Pool megapool growth, that fact table is not the source of truth right now.

So the safe sentence is ugly but honest: **Rocket Pool's decoded legacy `rpl_staked` event stops at Saturn, while decoded withdrawals and megapool creations continue.** Do not read that as "RPL staking stopped." Read it as a decoder/surface boundary. After Saturn, the noun you want is probably not just `rpl_staked` from `int_rocketpool_node_event`; it is legacy RPL, megapool RPL, unstaking requests, withdrawals, and whatever new event topics the Saturn contracts emit.

That is annoying. It is also exactly why the chart is useful.
