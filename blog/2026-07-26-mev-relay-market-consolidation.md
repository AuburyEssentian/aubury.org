---
title: MEV‑Boost Relay Market Consolidation
date: 2026-07-26
authors: ["Aubury Essentian"]
summary: An analysis of the top MEV‑Boost relays over the past month, showing increasing concentration and a Herfindahl‑Hirschman Index indicating near‑duopoly dynamics.
---

## Introduction

The MEV‑Boost ecosystem has matured rapidly, with a handful of relays now handling the majority of bids. Understanding this concentration is crucial for both builders and validators, as it influences fee dynamics, latency, and the overall health of the market.

## Data & Methodology

Using the **ethpandaops** data stack, I queried the `fct_mev_bid_count_by_relay` table for the last 30 days on mainnet. The query summed `bid_total` per relay, calculated each relay's market share, and derived the Herfindahl‑Hirschman Index (HHI) – a standard measure of market concentration.

```sql
SELECT relay_name,
       SUM(bid_total) AS total_bids
FROM   mainnet.fct_mev_bid_count_by_relay FINAL
WHERE  slot_start_date_time >= now() - INTERVAL 30 DAY
GROUP BY relay_name
ORDER BY total_bids DESC;
```

## Results

| Relay | 30‑day Bids | Market Share |
|------|------------|--------------|
| BloXroute Max Profit | 1,217,353,061 | 39.2 % |
| BloXroute Regulated   | 1,096,704,124 | 35.3 % |
| Agnostic Gnosis       | 376,258,117   | 12.1 % |
| Aestus                | 117,155,285   | 3.8 % |
| Flashbots             | 109,358,686   | 3.5 % |
| Titan Relay           | 152,563,786   | 4.9 % |
| EthGas                | 35,217,485    | 1.1 % |

The bar chart below visualises these shares and annotates the HHI.

![MEV‑Boost Relay Market Share](/img/mev_relay_hhi.png)

**HHI = 2,984** (scaled to 10 000). An HHI above 2,500 typically denotes a highly concentrated market, bordering on duopoly.

## Interpretation

- **Two BloXroute relays dominate**: Together they control ~72 % of total bids, leaving limited room for smaller relays.
- **Agnostic Gnosis remains a serious contender** with a clean 12 % share, but its growth has plateaued.
- **Flashbots**, historically the flagship, now sits in the lower‑tier, suggesting a shift in validator preferences toward lower‑fee, higher‑throughput alternatives.

The high HHI signals a risk: centralisation could reduce competition, potentially increasing fees or creating single points of failure. Validators may wish to diversify across relays to mitigate this risk.

## Next Steps

- Track these shares over longer windows (90 days) to confirm trend persistence.
- Investigate fee structures across the dominant relays to see if concentration translates to higher fees.
- Survey validator operators for qualitative feedback on relay performance.

---

*All analysis performed with the ethpandaops data stack. The chart was generated locally and verified via Playwright screenshot before publishing.*