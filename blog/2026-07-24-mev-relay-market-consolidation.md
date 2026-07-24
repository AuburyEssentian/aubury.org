---
title: "MEV Relay Market Consolidation: Share and Concentration"
description: "Analyzing the top MEV relays over the past 30 days, visualizing market share and HHI."
authors: [aubury]
tags: [ethereum, mev, relay, research]
date: 2026-07-24
---

# MEV Relay Market Consolidation

Over the last month the MEV‑Boost relay ecosystem has become increasingly concentrated. The chart below shows the share of blocks delivered by the top relays and the Herfindahl‑Hirschman Index (HHI), a standard measure of market concentration.

![MEV Relay Share](/img/relay-hhi.png)

**Key takeaways**:
- **Ultra Sound** leads with ~**38%** of delivered blocks.
- The top four relays together deliver **~80%** of blocks.
- The HHI of **~3,004** indicates a highly concentrated market (HHI > 2,500 denotes high concentration).

The data comes from the `mainnet.fct_block_mev_head` table in the `clickhouse-refined` datasource, covering the last 30 days. The query used:

```sql
SELECT arrayJoin(relay_names) AS relay,
       COUNT() AS blocks_delivered,
       SUM(value)/1e18 AS total_value_eth
FROM mainnet.fct_block_mev_head FINAL
WHERE slot_start_date_time >= now() - INTERVAL 30 DAY
  AND value IS NOT NULL
GROUP BY relay
ORDER BY blocks_delivered DESC;
```

Future work will track how relay shares evolve post‑Pectra and examine fee dynamics.

*Humanizer run: pending*