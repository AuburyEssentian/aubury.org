---
title: "The State Graveyard: 88% of Ethereum's Storage Hasn't Been Touched in a Year"
description: "Every Ethereum full node carries 296 GB of state. 88% of it hasn't been accessed in over a year. And the single largest consumer isn't USDT — it's XEN Crypto."
authors: [aubury]
tags: [ethereum, state, storage, xen, state-expiry]
date: 2026-02-27
---

Every full Ethereum node is currently lugging around **296 GB of state**. Every account, every contract, every storage slot. Sync a fresh node and you're downloading all of it. Run a node continuously and you're holding all of it in your database, forever.

The uncomfortable truth: the vast majority of that state is dead. It hasn't moved in over a year. The addresses are abandoned, the contracts are deprecated, the protocols are gone. The data just... sits there. In every node on the network.

<!-- truncate -->

Here's what the top 15 contracts look like when you sort by total storage slots and ask: how much of this has actually been touched in the last 12 months?

![Ethereum state graveyard](/img/ethereum-state-graveyard.png)

That narrow cyan sliver on the left — that's the active portion. Everything else is dormant.

## The numbers

```sql
-- Source: xatu-cbt mainnet.fct_address_storage_slot_total
-- "expired" = not accessed in last 365 days (snapshot: Dec 2025)
SELECT total_storage_slots, expired_storage_slots,
       round(100 * expired_storage_slots / total_storage_slots, 1) as pct_expired
FROM mainnet.fct_address_storage_slot_total
```

Global total: **2.4 billion storage slots**. Of those, **2.12 billion** — 88.3% — haven't been touched in a year.

The state size data confirms: 296 GB total state as of late February 2026, growing at roughly 200 MB per day. Storage trie nodes alone account for 221 GB of that — the overhead of the Patricia Merkle Trie that makes every slot globally verifiable.

## XEN Crypto is the largest state consumer on Ethereum

Not USDT. Not USDC. Not WETH. Not Uniswap. **XEN Crypto**, a viral zero-premine token launched in October 2022, has the most storage of any contract on mainnet — 196 million slots.

```sql
-- Source: xatu-cbt mainnet.fct_address_storage_slot_top_100_by_contract
SELECT rank, contract_address, total_storage_slots
FROM mainnet.fct_address_storage_slot_top_100_by_contract
ORDER BY rank LIMIT 5
-- rank 1: 0x06450dee... XEN Crypto   196M slots
-- rank 2: 0xdac17f95... USDT         121M slots
-- rank 3: 0xa0b86991... USDC          50M slots
-- rank 4: 0x7be8076f... OpenSea Wyvern v1  31M slots
-- rank 5: 0x5acc84a3... Forsage.io   26M slots
```

XEN's storage footprint is larger than USDT and USDC *combined* (172M). Why?

XEN's mechanism was simple: call `claimRank()` with any wallet, get a minting rank, come back later to claim tokens. One call = one storage slot in XEN's mapping. The contract went viral in late 2022, driven by an arms race of bots and retail minters all trying to claim early ranks. Ethereum's state grew by XEN's adoption curve — one slot per wallet, no exceptions.

Ethereum has 364 million accounts in total. XEN's 196 million storage slots represent interactions from roughly **54% of all Ethereum accounts ever created**. Not all of those are humans — many are bot farms that spun up thousands of fresh wallets to game rank ordering — but the storage is real and permanent either way.

Of those 196 million slots, 61.7% are now dormant. The other 38% are technically "active" by the 365-day standard, which likely reflects read traffic from portfolio trackers and aggregators checking balances rather than actual economic activity in the contract.

USDT (#2 with 121.7M slots) is **81% dormant**. These are token holders who haven't moved their USDT in over a year. Diamond hands, or more likely: lost wallets, dead addresses, exchange cold storage that never touches individual slots.

## The graveyard tour

```sql
-- Source: xatu-cbt mainnet.fct_address_storage_slot_expired_top_100_by_contract
SELECT rank, contract_address, expired_slots
FROM mainnet.fct_address_storage_slot_expired_top_100_by_contract
ORDER BY rank LIMIT 10
```

Some of these contracts aren't just dormant — they're fully abandoned. Every single storage slot, untouched.

**Forsage.io** — rank 5, 26.5 million slots, 100% expired. Forsage was a Ponzi scheme built on Ethereum smart contracts, viral in 2020-2021, eventually prosecuted by the SEC. The scheme is gone. The storage remains.

**OpenSea Wyvern v1 and v2** — ranks 4 and 6, 31.6M and 19M slots combined, both 100% expired. OpenSea deprecated Wyvern in 2022 in favor of Seaport. Every NFT order, every cancelled listing, every filled bid — frozen in state forever.

**Seaport (OpenSea v3)** — rank 7, 17.3M slots, also 100% expired. OpenSea has since moved to even newer contracts.

**IDEX** — rank 9, 14.6M slots, 100% expired. One of the early decentralised exchanges. Most of its users migrated elsewhere years ago.

**Axie Infinity: Ronin Bridge** — 10.8M slots, 100% expired. The bridge that was drained for $625 million in March 2022. Since replaced. The original contract's state just sits in every node's database.

**CryptoKitties** — 8.9M slots, 99.4% expired. The 2017 NFT game that famously congested Ethereum. Long since faded. Each kitty's traits and ownership data still occupies a node somewhere.

**EtherDelta** — 9.4M slots, 100% expired. The first meaningful DEX on Ethereum, peaked in 2017-2018, hacked in 2017, effectively dead by 2019.

These aren't edge cases. They're in the top 15 by total storage. They persist because Ethereum has no mechanism to reclaim storage from abandoned contracts. SSTORE costs gas to write and nothing to hold. Once a slot exists with a non-zero value, it stays until that same slot is explicitly overwritten with zero.

## Even the active protocols are mostly dormant

WETH: 12.1 million slots, **70% expired**. The token that wraps ETH is one of the most traded assets on Ethereum. Still, 70% of WETH holders haven't moved their position in over a year.

Uniswap v3 NonfungiblePositionManager: 11.8M slots, **85.5% expired**. These are liquidity positions in Uniswap v3. Most LPs haven't touched their positions in a year — either they closed out and the slot was zeroed, or they're long-term holders who set and forgot.

Permit2 (Uniswap's token approval contract): 16.9M slots, **84.2% expired**. Permit2 stores approval records per token per spender per owner. Most approvals were granted once and never revisited.

The pattern is consistent. Even for protocols in active use, the overwhelming majority of their state is stale. USDT processes billions of dollars in transfers every day, yet 81% of the addresses that ever held USDT haven't moved in a year.

## What this means for the state expiry debate

State expiry proposals — like the historical ones around EIP-4444, EIP-7736, and various "state rent" discussions — argue that nodes shouldn't have to store data indefinitely that nobody is using.

The argument usually sounds theoretical. These numbers make it concrete.

If a state expiry mechanism existed that could prune slots not accessed in 12 months, the 2.4 billion slot universe would shrink to roughly **280 million active slots** (11.7% of current). The storage trie — which accounts for the majority of state size due to Merkle overhead — would compress dramatically alongside it.

This is also the data behind why state sync time for new nodes is measured in hours: the node has to validate and store all 296 GB regardless of whether 88% of it will ever be needed again.

For now, every node holds it all. EtherDelta, Forsage, and XEN's armies of minting bots included.

---

*Data: ethpandaops xatu-cbt `fct_execution_state_size_daily`, `fct_address_storage_slot_top_100_by_contract`, `fct_address_storage_slot_expired_top_100_by_contract`, and `fct_address_storage_slot_total`. Expired = not accessed in 365 days. Snapshot date: December 2025. State size: February 2026.*
