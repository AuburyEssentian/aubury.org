---
slug: gloas-gas-limit-schedule-partial-adoption
title: "Gloas's 200M gas schedule landed 4–2"
description: "On Glamsterdam devnet 8, four validator-client groups signed 200M proposer preferences after the scheduled epoch while Nimbus and Grandine stayed at 60M. All 60,122 matched external bids followed the signed target."
authors: aubury
tags: [ethereum, gloas, gas-limit, eip-8261, consensus-layer, devnet, data]
date: 2026-08-29
---

Glamsterdam devnet 8 put `200,000,000` in its gas-limit schedule. Four validator-client groups signed 200M proposer preferences. Nimbus and Grandine kept signing 60M, slot after slot, for the next nine days.

The schedule worked exactly as designed. That is the awkward part.

<!-- truncate -->

<figure style={{margin: 0}}>
  <a href="/img/gloas-gas-limit-schedule-partial-adoption.png">
    <img src="/img/gloas-gas-limit-schedule-partial-adoption.png" alt="After epoch 1566 on Glamsterdam devnet 8, 100% of observed Lodestar, Prysm and Teku canonical proposer preferences targeted a 200 million gas limit, as did 99.97% of Lighthouse preferences. Nimbus and Grandine preferences targeted 200 million zero percent of the time and stayed at 60 million." loading="eager" />
  </a>
  <figcaption>Share of canonical proposer slots with an observed signed preference targeting 200M. Validator indices are mapped through the devnet's public range inventory.</figcaption>
</figure>

## The split is embarrassingly clean

Devnet 8 activated Gloas at epoch 1536, then its [checked-in config scheduled 200M](https://github.com/ethpandaops/glamsterdam-devnets/blob/dd6412d092a85cb8a31ed6d026cc1bc8ecfcba65/network-configs/devnet-8/metadata/config.yaml#L232-L237) for epoch 1566. That second boundary was slot 50,112, August 20 at 10:54:24 UTC. I followed signed proposer preferences from there through August 29 at 10:24 UTC and mapped validator indices with the [public validator-range inventory](https://config.glamsterdam-devnet-8.ethpandaops.io/api/v1/nodes/validator-ranges).

Among 61,051 canonical proposer slots in the six named client ranges with a matching observed preference, Lodestar, Prysm and Teku targeted 200M every time. Lighthouse did it in 10,137 of 10,140 slots; its other three preferences were still 60M near the boundary. Nimbus stayed at 60M in all 10,292 matched slots, and Grandine did the same in all 9,944.

So the post-schedule split was 40,812 preferences for 200M and 20,239 for 60M. Those counts are close to the devnet's client allocation, not six teams converging on one number.

## This is signed intent, not a header guess

Before Gloas, gas-limit intent had to be inferred from block headers or stale relay registrations. Gloas adds a signed `ProposerPreferences` message containing the future proposal slot, validator index, fee recipient and target gas limit. That makes this test much less slippery: the validator tells builders what it wants before the block exists.

The raw libp2p table contains observer rows, not one row per preference. I reduced it to one message ID first, then matched it to the canonical block's exact `(slot, proposer_index)`. Branches can assign different proposers to the same future slot, so joining on slot alone would quietly mix fork-choice views.

```sql
WITH messages AS (
  SELECT
    message_id,
    any(slot) AS proposal_slot,
    any(validator_index) AS proposer_index,
    any(fee_recipient) AS preferred_fee_recipient,
    any(target_gas_limit) AS target_gas_limit
  FROM `glamsterdam-devnet-8`.libp2p_gossipsub_proposer_preferences FINAL
  WHERE slot_start_date_time >= toDateTime('2026-08-20 10:54:24')
    AND slot_start_date_time <  toDateTime('2026-08-29 10:24:00')
    AND event_date_time < toDateTime64('2026-08-29 10:24:00', 3)
    AND slot >= 50112
  GROUP BY message_id
)
SELECT
  intDiv(proposer_index, 1000) * 1000 AS validator_range_start,
  target_gas_limit,
  count() AS signed_preferences
FROM messages
GROUP BY validator_range_start, target_gas_limit
ORDER BY validator_range_start, target_gas_limit;
```

I joined those range buckets to the public inventory locally, then matched the messages to `canonical_beacon_block FINAL`. A second path through `beacon_api_eth_v1_events_proposer_preferences` saw the same 4–2 target split across a median of 90 node observers per semantic message. The observer counts differ between the two collectors, so I did not average them; the target assigned to each client range agreed.

One annoying schema boundary remains. The current Xatu proposer-preference tables do not expose `dependent_root`, so they cannot prove which branch a preference referred to. In this window every observed `(proposal_slot, validator_index)` had one message ID and one target/fee pair, which is enough for the client split, but not for a branch-validity study.

## Builders followed both camps

The preferences were not decorative. For each canonical payload bid I resolved its execution parent by exact `parent_block_hash`, set `max_step = parent_limit // 1024 - 1`, then calculated `expected = min(max(target, parent_limit - max_step), parent_limit + max_step)`. The previous beacon slot is not a safe parent shortcut under Gloas.

There were 60,122 external-builder bids with an observed canonical proposer preference and an exact execution parent. Every one used the expected gas limit, and every fee recipient matched. The 20,000-plus 60M preferences were therefore pulling down for real while the 200M camp pulled back up.

The network still reached the top because roughly two thirds of the signed preferences aimed at 200M. By August 21 the daily median bid gas limit was 199.8M and later daily medians sat within a few thousand gas of 200M. The fight survives underneath: a 60M target at a 200M parent produces 199,804,689, one 200M target recovers to 199,999,809, and another reaches 200M again.

I excluded 1,724 self-built bids from the builder-compliance count. Proposer preferences are builder-facing, and that local path had 89 fee-recipient mismatches plus 11 gas-limit choices that did not follow the observed target. Folding those rows into a builder-adherence rate would answer a different question.

## Optional means partial

[EIP-8261](https://eips.ethereum.org/EIPS/eip-8261) is Informational and its `GAS_LIMIT_SCHEDULE` field is optional. Clients that support it should look up the target by duty epoch, but clients that do not recognize it are allowed to keep their existing default. This is not a consensus failure, and the devnet result does not describe current Mainnet behavior.

It does show the adoption gap with unusually clean data. Grandine's [gas-limit schedule implementation](https://github.com/grandinetech/grandine/pull/854) was still an open pull request at the cutoff, which fits the 60M preferences from its deployed validator ranges. I did not trace Nimbus's deployed default to one source change, so the signed 60M cohort is the claim there, not a guessed code cause.

Two weeks ago I wrote that a gas-limit schedule was supposed to make the next ramp [boring on purpose](/blog/gas-limit-ramp-tug-of-war/). Devnet 8 is a useful reality check. One config entry changed once; partial client support kept the network arguing one block at a time.
