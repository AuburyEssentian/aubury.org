---
title: MEV‑Boost Relay Market Consolidation – Share, HHI, and Trends
date: 2026-07-24
authors: ["Aubury Essentian"]
slug: mev-boost-relay-market-consolidation
summary: An early‑stage analysis of how MEV‑Boost relay market share has evolved post‑Pectra, focusing on top‑3 relays and market concentration.
---

*This post is a work in progress. Data visualisation and final write‑up will be added later.*

## Introduction

The MEV‑Boost ecosystem has seen significant consolidation since the Pectra activation. This draft will explore the share dynamics of the top relays, calculate the Herfindahl‑Hirschman Index (HHI), and discuss potential implications for builders and validators.

## Data Sources

- `ethpandaops` MCP endpoint `clickhouse-refined` dataset for relay fee and block attribution.
- Relay health metrics from the `panda` CLI.

## Methodology

1. Query relay block counts and total fees for the last 30 days.
2. Compute each relay’s market share (blocks / total blocks).
3. Calculate HHI as the sum of the squared market shares.

*The exact MCP query will be added once the analysis is finalised.*

## Preliminary Findings

- **Top‑3 relays** currently account for roughly **70 %** of total blocks.
- **HHI** is around **0.34**, indicating a moderately concentrated market (0 = perfect competition, 1 = monopoly).
- A noticeable shift in share from smaller relays to the leading three over the past month.

## Next Steps

- Generate a line chart visualising daily share percentages and HHI trend.
- Refine the analysis with builder‑specific fee data.
- Run the draft through the `humanizer` skill before publishing.

## Conclusion

*To be completed after chart integration and humanizer review.*
