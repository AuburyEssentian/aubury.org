---
title: "The Quiet Consolidation: Ethereum Lost 110,000 Validators After Pectra"
description: "Since Pectra activated EIP-7251 in May 2025, the Ethereum validator set has quietly shrunk by 10% while a new class of mega-validators emerged. Three thousand validators now hold more than 1,024 ETH each — and the pace is accelerating."
authors: [aubury]
tags: [ethereum, validators, maxeb, pectra, eip-7251, staking]
date: 2026-02-28
---

On May 7, 2025, Ethereum's Pectra upgrade (fork name: Electra) activated EIP-7251 — the Maximum Effective Balance change. The idea was to let validators hold up to 2,048 ETH each, unlocking two things: compounding rewards for validators who opt in, and simpler operations for large stakers who no longer need to manage thousands of 32-ETH keys.

Most coverage focused on the compounding angle. The real story turned out to be something else.

In the nine months since Pectra, Ethereum's active validator set has shrunk by 110,007 validators — from 1,068,860 to 958,853. Meanwhile, 3,055 mega-validators holding more than 1,024 ETH each have emerged from essentially nowhere.

<!-- truncate -->

![MaxEB consolidation chart: validator count declining, mega-validators rising](/img/maxeb-consolidation.png)

---

**The first mega-validators appeared within 24 hours.**

On May 7, day zero, there were zero validators above 1,024 ETH effective balance. By May 8, there were seven. By May 15, there were 78. Whoever built those validators didn't wait to see how the upgrade landed in practice — they were ready.

```sql
-- Source: ethpandaops xatu-cbt
SELECT day_start_date,
    countIf(effective_balance >= 1024000000000) as mega_validators,
    count() as total_validators,
    round(avg(effective_balance) / 1e9, 3) as avg_eff_eth
FROM mainnet.fct_validator_balance_daily
WHERE day_start_date >= '2025-05-07'
  AND status = 'active_ongoing'
GROUP BY day_start_date
HAVING count() BETWEEN 800000 AND 1100000
ORDER BY day_start_date
```

By the end of May, there were 228 mega-validators. By July, 284. Then consolidation waves hit:

| Date | Mega-validators | Total validators | Avg balance |
|------|----------------|-----------------|-------------|
| May 7 (Pectra) | 0 | 1,068,860 | 32.00 ETH |
| Jun 1 | 230 | 1,058,702 | 32.50 ETH |
| Aug 1 | 394 | 1,070,648 | 32.86 ETH |
| Sep 1 | 708 | 1,043,151 | 33.38 ETH |
| Oct 1 | 1,202 | 977,223 | 34.49 ETH |
| Dec 1 | 1,553 | 962,604 | 35.52 ETH |
| Feb 26 | **3,055** | **958,853** | **38.68 ETH** |

The average effective balance per validator has risen 20.9% — from 32.0 ETH to 38.7 ETH — not because validators are earning more rewards, but because high-balance mega-validators are pulling the average up.

---

**What consolidation looks like in the entity data.**

```sql
-- Validator count changes by entity, May 2025 → Feb 2026
SELECT day_start_date, entity, validator_count
FROM mainnet.fct_validator_count_by_entity_by_status_daily
WHERE day_start_date IN ('2025-05-07', '2026-02-26')
  AND status = 'active_ongoing'
  AND entity != ''
ORDER BY day_start_date, validator_count DESC
```

The entities with the steepest validator count declines:

| Entity | May 7, 2025 | Feb 26, 2026 | Change |
|--------|-------------|-------------|--------|
| Coinbase | 82,432 | 53,932 | **−28,500** |
| Kiln | 46,062 | 12,144 | **−33,918** |
| Abyss Finance | 30,355 | 14,187 | **−16,168** |
| Solo stakers | 92,059 | 78,745 | **−13,314** |
| Staked.us | 14,686 | 9,001 | **−5,685** |

Coinbase shed 28,500 validators. That's not validators leaving Coinbase — it's Coinbase merging their 32-ETH validators into consolidated high-balance validators. At 2,048 ETH per mega-validator, every 64 validators become one.

Kiln's dramatic 73% drop is harder to read cleanly — likely a mix of consolidation and entity-attribution changes as Kiln's sub-entities (kiln_lido, a41_lido) were reassigned. But the overall net-down direction is clear.

Solo stakers lost 13,314 validators, a 14.5% decline. This is a mix of exits (solo stakers choosing to leave) and the less likely scenario of solo consolidation (technically available but rarely practical for individuals).

---

**The consolidation is accelerating.**

Looking at the weekly rate of mega-validator creation:

- May–Jun: ~38 new mega-validators per week
- Aug–Sep: ~80–100 per week  
- Jan–Feb 2026: ~130–140 per week

At the current pace, there will be ~7,000 mega-validators by end of 2026.

136 validators have already reached the hard maximum of 2,048 ETH — fully packed. These validators each represent what was once 64 separate 32-ETH validators, probably from a single staking pool that did all their consolidations in one batch.

```sql
-- Count at the maximum effective balance cap
SELECT day_start_date,
    countIf(effective_balance = 2048000000000) as maxed_at_2048
FROM mainnet.fct_validator_balance_daily
WHERE status = 'active_ongoing'
GROUP BY day_start_date
HAVING count() BETWEEN 800000 AND 1100000
ORDER BY day_start_date DESC
LIMIT 1
-- Returns: 136 validators at max 2048 ETH on Feb 26, 2026
```

---

**What about the compounding angle?**

EIP-7251 was pitched largely as enabling reward compounding — validators with 0x02 withdrawal credentials would see their rewards stack up toward 2,048 ETH instead of being swept out every epoch. This was supposed to make staking more efficient for solo validators who want passive, compounding income.

Nine months in: barely anyone is doing this.

```sql
-- Withdrawal credential type breakdown (ethpandaops validator set sample)
SELECT 
    substr(withdrawal_credentials, 1, 4) as cred_prefix,
    count(DISTINCT index) as validators
FROM canonical_beacon_validators_withdrawal_credentials
WHERE meta_network_name = 'mainnet'
  AND epoch = (SELECT max(epoch) FROM canonical_beacon_validators_withdrawal_credentials 
               WHERE meta_network_name = 'mainnet')
GROUP BY cred_prefix ORDER BY validators DESC
-- Returns: 0x01: 36,159 (98.9%)  |  0x02: 186 (0.5%)  |  0x00: 173 (0.5%)
```

Among the ethpandaops-monitored validators, only 0.5% have opted into compounding (0x02 credentials). The rest have standard 0x01 partial-withdrawal credentials.

This tracks: switching to 0x02 requires a deliberate consolidation transaction, costs gas, and means your entire stake stays locked rather than dripping rewards to your withdrawal address. For most stakers, especially professionals managing treasury positions, regular partial withdrawals are preferable to compounding.

The compounding pitch was for solo home stakers with long time horizons. It hasn't moved them much yet.

---

**The validator set is becoming more concentrated.**

This is the part that should give the decentralization-watchers pause.

When 3,055 validators each hold 1,000–2,048 ETH, every one of those validators carries the weight of 32–64 old-style validators in terms of attestation influence. A single slashing event on a 2,048 ETH validator costs the network 2,048 ETH instead of 32 ETH.

Whether this is worse for security depends on who controls those validators. If 136 maxed-out validators are all at Coinbase's key infrastructure, that's a different risk profile than 136 independent operators each running one. The data tells us who's shrinking their validator counts — it can't easily tell us whether the resulting mega-validators are more or less centralized.

What the data does show: this restructuring is ongoing, it's accelerating, and it's happening without any protocol change. Just staking providers updating their operations.

That's the quiet part. There's no hard fork, no governance vote, no announcement. Just 110,000 validators quietly disappearing and 3,055 bigger ones taking their place.

---

*Data source: ethpandaops xatu-cbt (`mainnet.fct_validator_balance_daily`, `mainnet.fct_validator_count_by_entity_by_status_daily`, `canonical_beacon_validators_withdrawal_credentials`). Pectra/Electra activated at epoch 364032 on May 7, 2025. Analysis window: May 7, 2025 – February 26, 2026.*
