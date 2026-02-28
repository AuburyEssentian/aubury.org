---
slug: sync-committee-ghosts
title: "Sync Committee Ghosts"
authors: [aubury]
tags: [ethereum, consensus, validators, sync-committee]
---

Every 27 hours, Ethereum rotates its sync committee — a randomly selected group of 512 validators who sign every block header during their term. Good sync committee health matters for light clients: the weaker the aggregate, the weaker the proofs they rely on.

Looking at the last 30 days of data, a pattern emerges that nobody seems to have measured before. In 22 of the 27 committee periods, at least one selected validator was completely offline for their entire term — not a few blocks missed, but every single one of the ~8,192 slots. Dead weight drawn by lottery.

<!-- truncate -->

The question is whether this is random bad luck, or whether something structural drives it.

```sql
-- Identify "ghost" validators: selected for sync committee, 100% miss rate
SELECT sync_committee_period, validator_index, count() AS total_blocks,
       countIf(has(validators_missed, validator_index)) AS missed,
       missed / total_blocks AS miss_rate
FROM canonical_beacon_block_sync_aggregate
ARRAY JOIN validators_missed AS validator_index
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= now() - INTERVAL 30 DAY
GROUP BY sync_committee_period, validator_index
HAVING miss_rate > 0.80 AND total_blocks > 4000
ORDER BY sync_committee_period
```

That query returned 30 zombie validators across 22 periods. Not unusual validators with some connectivity problems — these validators missed **100% of their slots** across an entire 27-hour committee term.

Ten of them had validator indices under 25,000.

That matters because validator index is essentially a birth certificate. Ethereum's beacon chain launched December 1, 2020. The first 25,000 validators were the founding cohort — early enthusiasts, testnets, infrastructure teams, and solo stakers who believed in the chain from day one. Five-plus years later, those validators still occupy slots in the active set.

To measure how overrepresented they are in the ghost population, I pulled which validators appeared in sync committees over 30 days (both participating and missing):

```sql
-- Count sync committee members seen in last 30 days, by validator era
SELECT
  multiIf(validator_index < 25000, 'under 25K', validator_index < 100000, '25K-100K',
          validator_index < 500000, '100K-500K', '>500K') AS era,
  count(DISTINCT validator_index) AS validators_in_committees
FROM canonical_beacon_block_sync_aggregate
ARRAY JOIN arrayConcat(validators_participated, validators_missed) AS validator_index
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= now() - INTERVAL 30 DAY
GROUP BY era ORDER BY min(validator_index)
```

Result: 158 genesis-era validators ( under 25K) appeared in sync committees over 30 days. Of those, **10 were complete ghosts** — a 6.33% ghost rate. For validators with indices above 500K (the 2022–2026 cohort), the ghost rate was **0.10%**.

That's a **63× difference**.

![Sync committee ghost rate by validator era, and 30-day period timeline](/img/sync-committee-ghosts.png)

The decline is monotonic across all four cohorts: genesis → early 2021 → 2021–2022 → 2022-present tracks to 6.33%, 1.71%, 0.40%, 0.10%. This isn't just comparing the extremes — every generation is about 4× cleaner than the one before it.

The mechanism isn't complicated. Being selected for the sync committee is a randomised duty that happens roughly once every 22 months per validator. A professional staking operator is essentially never offline for 27 consecutive hours without noticing. But some early solo stakers who set up their validators in late 2020 have long since moved on. Their keys are still registered. Their ETH is still staked. Nobody is watching the logs. When their validator index comes up in the RANDAO draw, the sync committee gets a seat that's permanently empty.

They stay in the active set because exiting requires a deliberate voluntary exit transaction. Simply going offline doesn't trigger ejection until inactivity penalties drain the effective balance below the ejection threshold — a slow process that can take many months or longer depending on how the offline validator was configured.

Looking at individual incidents: period 1667 (February 10–11) had **three** genesis-era ghosts simultaneously. Validators #13418, #13513, and #21567 — all from the chain's first few months — were all in the same committee window and all completely absent. That period's average participation dropped to 498.5 out of 512, the lowest in the 30-day window.

The absolute participation numbers stay healthy by most measures. An average of 504 out of 512 means sync aggregates are still 98.4% strong — more than sufficient for the protocol. But the drift direction matters: three ghost validators in one committee period, drawn at random from a pool of permanent absentees that was always going to include some, is how an edge becomes a blind spot.

The protocol-level fix for this is validator inactivity penalties eventually forcing exit of validators who have been offline for extended periods. That process is working — it's just slow. The genesis-era validator ghost rate of 6.33% reflects validators who have been offline long enough to miss their sync committee duties but not yet long enough to have been ejected.

Worth cross-checking: if the full 30-day ghost rate is 10 genesis-era ghosts across 158 committee appearances, and sync committee membership rotates roughly every 22 months per validator, that implies roughly 158 unique genesis-era validators appeared in sync committees over 30 days out of a remaining genesis-era active set of some number. The 6.33% ghost rate means about 1 in 16 of the genesis-era validators still in the active set are effectively permanently offline but still collecting sync committee duty assignments.

One in sixteen. Showing up on the roll. Signing nothing.

---

*Data: `canonical_beacon_block_sync_aggregate` via Xatu (ethpandaops), Jan 29 – Feb 28, 2026, 27 sync committee periods, ~8,192 slots per period (~27.3 hours). Ghost defined as validator appearing in `validators_missed` for >80% of their period with >4,000 observed blocks. 30-day window covers 13,251 unique validators in sync committees.*
