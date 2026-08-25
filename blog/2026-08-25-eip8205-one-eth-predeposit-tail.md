---
slug: eip8205-one-eth-predeposit-tail
title: "910 one-ETH validators are still waiting for the other 31"
description: "Since Pectra, 20,717 new validator keys first appeared behind a 1 ETH deposit request. At epoch 470,860, 910 still held exactly 1 ETH and remained pending_initialized; their median age was 404 days."
authors: aubury
tags: [ethereum, validators, deposits, eip-8205, staking, data]
date: 2026-08-25
---

Mainnet still has 910 validator records with exactly 1 ETH. They are all `pending_initialized`, their median age is 404 days, and none can activate unless somebody supplies the other 31 ETH. [EIP-8205](https://eips.ethereum.org/EIPS/eip-8205) exists to stop protocols from creating this awkward little balance in the first place.

<!-- truncate -->

<img src="/img/eip8205-one-eth-predeposit-tail.png" alt="A dark chart showing that 20,717 new Mainnet validators started with exactly 1 ETH after Pectra. Of those, 19,807 later reached at least 32 ETH in deposit requests while 910, or 4.4 percent, still held exactly 1 ETH after a median of 404 days. All 910 were pending initialized at epoch 470,860." loading="eager" />

This is not a live protocol change. EIP-8205 is Draft, has no Mainnet activation, and still leaves the execution request type and predeploy address as `TBD`. What changed today is that its [consensus feature spec](https://github.com/ethereum/consensus-specs/pull/5548) merged at 04:06 UTC; the Mainnet data below runs through 05:15 UTC, just over an hour later.

The proposal attacks a nasty safety tradeoff in delegated staking. A protocol wants proof that a validator key really points withdrawals at the protocol before it sends the full 32 ETH. The [companion rationale](https://hackmd.io/@george-avs/r1oK_afsbe) describes the current workaround: send a small predeposit, wait until the validator appears in consensus state, verify the credentials, then send the rest. If the second payment never comes, the small balance cannot activate or leave on its own.

## One ETH was the real initial partial

I started with `canonical_beacon_block_execution_request_deposit`, one row per canonical EIP-6110 deposit request. The table begins at Pectra and was current through slot 15,067,577. I sorted every pubkey's requests by `(slot, position_in_block)`, then kept keys whose first request was below 32 ETH.

```sql
SELECT pubkey, events
FROM
(
  SELECT
    pubkey,
    arraySort(
      x -> (tupleElement(x, 1), tupleElement(x, 2)),
      groupArray((
        slot,
        position_in_block,
        amount,
        slot_start_date_time,
        withdrawal_credentials,
        block_root
      ))
    ) AS events
  FROM default.canonical_beacon_block_execution_request_deposit FINAL
  WHERE meta_network_name = 'mainnet'
  GROUP BY pubkey
)
WHERE tupleElement(events[1], 3) < toUInt128(32000000000);
```

That produced 22,188 pubkeys, but the number is not yet a validator count. I resolved each key through `canonical_beacon_validators_pubkeys`, then fetched its first daily state row in literal batches of 3,000 indices. `start_epoch` gives the exact first epoch inside that daily row, rather than forcing the date to stand in for registry time.

```sql
SELECT
  validator_index,
  min(day_start_date) AS first_day,
  argMin(start_epoch, tuple(day_start_date, updated_date_time))
    AS first_epoch,
  argMin(status, tuple(day_start_date, updated_date_time))
    AS first_status
FROM mainnet.fct_validator_balance_daily FINAL
WHERE validator_index IN (<literal batch>)
GROUP BY validator_index;
```

I classified a key as new only when its first validator epoch came after its first deposit request. I also checked the pre-Pectra `canonical_beacon_block_deposit` history for all candidates; none of the final cohort had a legacy deposit hiding outside the EIP-6110 table. After those gates, there were 20,717 genuine new validators with a partial first request. Every one started at exactly 1 ETH. The other below-32 rows were existing-validator top-ups or keys that never appeared in state.

## The missing 31

Of those 20,717 validators, 19,807 later accumulated at least 32 ETH in canonical deposit requests. For 19,724 of them, the visible shape was the obvious one: 1 ETH followed by exactly 31 ETH. The median gap from the first request to enough requested balance was 78.58 hours.

The other 910 never accumulated 32 ETH by the query head. This was not a stale rollup artifact: I fetched all 910 indices directly from `canonical_beacon_validators FINAL` at raw epoch 470,860. The query returned every index exactly once, every balance and effective balance was exactly 1,000,000,000 gwei, and every status was `pending_initialized`.

That is 910 ETH sitting in validator state, not 28,210 ETH. The missing 31 ETH per key was never deposited, so it would be wrong to count it as locked capital. What is real is the age of the balance already there: the median was 403.98 days, with the 10th and 90th percentiles at 403.77 and 409.12 days. This is mostly one very tight, very old batch rather than a smooth tail of recent attempts.

## The order was not always proof first

The completed 1-plus-31 flows split into two clocks. For 15,548 validators, the key appeared in state before or at the request that brought cumulative deposits to 32 ETH. The remaining request followed the first state row by a median of 5.69 hours, which is compatible with a protocol waiting for a state proof.

Another 4,259 had already requested enough to reach 32 ETH before the validator first appeared in state. Their first registry row came a median of 51.61 hours after the funding request. An amount pattern alone therefore cannot identify a bond-verification scheme; a `1 + 31` sequence can happen on either side of the registry clock.

I spot-checked both orders against raw per-epoch validator state. The first raw row for each sampled validator was present at the epoch derived from the daily model, absent one epoch earlier, and carried a 1 ETH balance. That keeps request inclusion, registry creation and later balance processing separate instead of pretending they are one event.

## What EIP-8205 would change

EIP-8205 adds a preregistration request containing the validator pubkey and withdrawal credentials. Consensus stores that pair for about 36.4 days. A later deposit for the key must match, so a delegated protocol can preregister, wait for finality, then send the full 32 ETH without first creating a 1 ETH validator record.

The proposal would not rescue today's 910 validators. They still need top-ups under current rules, and a future fork would need explicit migration logic to do anything else. It also would not prove that every historical predeposit came from an unsafe protocol; the deposit tables do not expose the offchain key handoff or the contract branch that authorized the second payment.

The 910 records are the ugly version of the problem. A 1 ETH validator can sit unusable for more than a year, and Mainnet has one stubborn cohort doing exactly that. If EIP-8205 survives review, an abandoned preregistration can expire instead of leaving another tiny validator balance behind.
