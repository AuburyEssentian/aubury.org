---
title: "The Zombie State Problem: What Reactivation Data Reveals About State Expiry"
description: "97 million 'expired' storage slots came back to life in 55 days. Half of them were XEN Crypto — and the timing tells a story about why choosing the right expiry threshold matters enormously."
authors: [aubury]
tags: [ethereum, state, verkle, eip-4444, xen, data]
date: 2026-03-04
---

State expiry has been one of Ethereum's most discussed, least implemented scaling ideas. The core promise: stop nodes from having to hold 1.3 billion dormant storage slots that haven't been touched in over a year. Just expire them. Make clients store a proof if they ever need to resurrect one.

The problem is nobody had measured how often "dead" state actually comes back to life.

I tracked every storage slot reactivation on mainnet — slots that had been dormant for at least 12 months before being accessed again — across a 55-day window from December 18, 2025 to February 11, 2026. The results are stranger than expected.

<!-- truncate -->

## The numbers

Today, Ethereum has roughly **1.29 billion storage slots** that haven't been touched in over 12 months. Under any serious state expiry proposal, those would be candidates for expiry — nodes could drop them and require a witness proof on first access.

In those 55 days, **97.5 million reactivation events** hit that 12-month-dormant bucket. That's 7.5% of all "expired" state waking up in less than two months.

```
-- Query: xatu-cbt / mainnet.int_storage_slot_reactivation_12m
-- All reactivations of slots dormant >12 months, Dec 18 2025 to Feb 11 2026
SELECT count() FROM mainnet.int_storage_slot_reactivation_12m
-- Result: 97,466,839
```

Those 97 million events involved 92 million unique (address, slot_key) pairs — almost no double-counting. These are genuinely distinct slots being accessed for the first time in over a year.

Extrapolated: if this rate held year-round, roughly 47% of all 12-month-expired state would be reactivated annually. That's not expiry — that's purgatory.

But the distribution is wildly uneven.

## XEN Crypto is half the problem

One contract — `0x06450dee7fd2fb8e39061434babcfc05599a6fb8`, XEN Crypto — accounted for **48.3 million** of those 97.5 million reactivation events. Nearly 50% of all 12-month zombie activity, from a single token.

```
-- Top contracts by 12-month reactivation (Dec 18, 2025 – Feb 11, 2026)
SELECT address, count() as reactivations, countDistinct(slot_key) as unique_slots
FROM mainnet.int_storage_slot_reactivation_12m
GROUP BY address ORDER BY reactivations DESC LIMIT 5
-- 0x0645... (XEN Crypto): 48,302,239 events, 45,665,915 unique slots
-- 0xdac1... (USDT):        2,403,772 events
-- 0x57f1... (ENS):         1,814,498 events
```

And then it gets weird. Most of those XEN reactivations didn't happen gradually. They happened in three days.

![State expiry witness burden by threshold](/img/state-expiry-zombie-state.png)

On December 20-21, 2025, **41.8 million XEN storage slots** — slots that had been dormant for 12+ months — were accessed in a 72-hour window. That's 570× the normal daily baseline. The day before: 8.9 million. The day after: 6.1 million. Then near-silence.

```
-- Dec 20-22 spike: which contracts dominated?
SELECT address, count() as reactivations
FROM mainnet.int_storage_slot_reactivation_12m
WHERE updated_date_time >= '2025-12-20' AND updated_date_time < '2025-12-23'
GROUP BY address ORDER BY reactivations DESC LIMIT 3
-- XEN:  41,816,729 (77% of all)
-- ENS:   1,267,952
-- USDT:  1,252,292
```

This was a mass XEN claiming event. XEN's tokenomics require users to call `claimRank()` to start a mint, then wait for a maturity window (1–550 days), then call `claimMintReward()` to collect. Each user's mint record lives in a storage slot. During peak XEN activity in late 2024, millions of addresses started mints — those slots became dormant as users waited. Then, in late December 2025, the maturities converged.

Half those slots hadn't been touched since before September 2023 — over two years dormant. Under a 12-month state expiry, every one of those claiming users would need to provide a cryptographic witness to access their own token balance. 41 million witnesses in 72 hours.

## The threshold is everything

Here's the non-obvious part. Moving the expiry threshold from 12 months to 18 months doesn't just reduce the witness burden by 50%. It reduces XEN's contribution by 195×.

```
-- XEN reactivations by dormancy tier (55-day window)
XEN >1mo dormant:  120M reactivations
XEN >6mo dormant:   78M reactivations
XEN >12mo dormant:  48M reactivations
XEN >18mo dormant:  234K reactivations  ← cliff
XEN >24mo dormant:   51K reactivations
```

The entire XEN mass-claim cycle lives in the 12–18 month band. XEN mints have maturity windows up to 550 days (~18 months). A 12-month threshold catches them; an 18-month threshold doesn't. That's not a coincidence — it's the protocol's design creating a deterministic annual state reactivation pulse.

The same pattern, at smaller scale, appears across the board. ENS name renewals, USDT holders returning after years of inactivity, CryptoKitties trades (yes, still happening — 263K reactivations of slots dormant 2+ years). ERC-20 token holders don't follow linear activity curves; they follow human behavior, which has annual and event-driven cycles.

At 18+ months, the picture stabilizes. The >18mo tier has 30.4 million reactivations in 55 days, but XEN is only 234K of them (0.8%). The dominant players shift to USDT, ENS, SHIB, LINK, and USDC — genuine long-dormant balance slots being touched when prices move.

```
-- Top contracts for >18mo dormant reactivations (no XEN)
SELECT address, count() FROM mainnet.int_storage_slot_reactivation_18m
GROUP BY address ORDER BY count() DESC LIMIT 5
-- USDT:   1,410,443
-- ENS:    1,140,091
-- LINK:     802,960
-- SHIB:     762,443
-- USDC:     609,076
```

## What this means for state expiry design

The data points toward a few conclusions.

**A 12-month threshold would create known worst-case storms.** The XEN event is a proof of concept for a broader class of problem: any protocol with time-locked claims, annual staking cycles, or periodic reward distribution will create synchronized mass reactivations exactly at the expiry boundary. Ethereum has dozens of protocols with these patterns.

**18–24 months is a cleaner threshold.** At 18 months, XEN drops off almost entirely. At 24 months, you're left with ~20.5 million reactivation events over 55 days — about 373K/day — distributed across thousands of contracts with no single dominant actor. The witness generation burden becomes manageable and predictable.

**The "graveyard" is real but layered.** The [state graveyard post](/blog/2026/02/27/ethereum-state-graveyard) found 2.4 billion dormant slots. But the reactivation data shows those aren't uniform deadweight. Roughly 7% reactivate under a 12-month threshold in any given 55-day window, concentrated in a handful of protocols with annual mechanics. The truly dead state — untouched for 24+ months, never touching again — is there, but it lives under the zombie layer.

State expiry isn't broken, but it's not as clean as the gigabyte headline numbers suggest. The threshold choice is an engineering decision that lands very differently depending on whether you pick 12 versus 18 months — not because of abstract cryptographic arguments, but because of XEN Crypto's maturity schedule.

---

*Data: ethpandaops xatu-cbt mainnet cluster. Tables: `int_storage_slot_reactivation_*`, `int_storage_slot_expiry_*`. Window: December 18, 2025 – February 11, 2026.*
