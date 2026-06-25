---
slug: exit-epoch-is-not-exit-time
title: The exit epoch is not when the validator exited
description: In 31 complete UTC days, 75.4% of mainnet voluntary exits carried a message epoch older than 30 days or epoch 0. The epoch field is a validity lower bound, not event time.
authors: aubury
tags: [ethereum, validators, exits, consensus, data]
date: 2026-06-26
---

A voluntary exit has an `epoch` field, and it is very tempting to read that as "the epoch this validator exited." That is wrong in exactly the way that produces fake history. In the last 31 complete UTC days, **75.4%** of mainnet voluntary exits carried an epoch more than 30 days old, or epoch 0.

The exit happened when the message landed in a canonical block. The message epoch was just the point from which the signature became valid.

<!-- truncate -->

<figure>
  <a href="/img/exit-epoch-is-not-exit-time.png"><img src="/img/exit-epoch-is-not-exit-time.png" alt="Dark stacked bar chart showing mainnet voluntary exits included from May 25 through June 24 2026, split by how old the exit-message epoch was at inclusion. Most exits are 30-444 days old or more than 444 days old; a June 22 batch is mostly fresh." loading="eager" /></a>
  <figcaption>Source: Xatu raw <code>canonical_beacon_block_voluntary_exit</code>, mainnet, May 25-June 24 2026 UTC. Age is <code>canonical block epoch - voluntary_exit_message_epoch</code>.</figcaption>
</figure>

I went into the voluntary-exit tables expecting the usual shape: a little daily noise, maybe a few staking-operator batches, and recent message epochs clustered around the inclusion epoch. The batches were there. The recent epochs were not.

Across **25,099** canonical voluntary exits from May 25 through June 24, only **6,016** had a message epoch that was current or one epoch old at inclusion. **18,929** had a message epoch older than 30 days, or exactly epoch 0. The stale tail was not a rounding error: **10,621** exits were more than 100,000 epochs old, or epoch 0. At 6.4 minutes per epoch, 100,000 epochs is about **444 days**.

Here is the query shape I used for the chart. The important bit is that the date filter is the canonical block inclusion time, while the age bucket comes from the signed exit message inside that block:

```sql
SELECT
  toDate(slot_start_date_time) AS day,
  multiIf(
    voluntary_exit_message_epoch = 0, 'epoch0',
    epoch - voluntary_exit_message_epoch < 2, 'fresh_lt2',
    epoch - voluntary_exit_message_epoch < 32, 'age_2_31_epochs',
    epoch - voluntary_exit_message_epoch < 225, 'age_32_224_epochs',
    epoch - voluntary_exit_message_epoch < 1575, 'age_1_7_days',
    epoch - voluntary_exit_message_epoch < 6750, 'age_1_30_days',
    epoch - voluntary_exit_message_epoch < 100000, 'age_30d_444d',
    'ancient_gt100k'
  ) AS bucket,
  count() AS exits
FROM canonical_beacon_block_voluntary_exit
WHERE meta_network_name = 'mainnet'
  AND slot_start_date_time >= toDateTime('2026-05-25 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-06-25 00:00:00')
GROUP BY day, bucket
ORDER BY day, bucket;
```

May 26 is the loudest example. Mainnet included **7,923** voluntary exits that day. The biggest message-epoch clusters were not fresh: epoch **390489** contributed **3,343** exits with an average age of **266.8 days**, epoch **342959** contributed **2,148** exits at **478.0 days**, and epoch **385089** contributed **1,621** exits at **290.7 days**. Those were not exits that happened in old epochs. They were old signed messages being used now.

The weirder-looking case is epoch 0. From May 28 through June 24, canonical blocks included **311** voluntary exits whose signed message epoch was exactly **0**. Three of them appeared in the final two complete days of the sample, at inclusion epochs around **456,772-456,986**, so the apparent age was about **2,031 days**. If you grouped those rows by `voluntary_exit_message_epoch`, you would put 2026 exits at genesis.

That sounds absurd until you read the state transition. A voluntary exit does not say "process me only at this epoch." It says "do not process me before this epoch." The [Phase0 spec](https://github.com/ethereum/consensus-specs/blob/master/specs/phase0/beacon-chain.md#voluntary-exits) check is blunt:

```python
# Exits must specify an epoch when they become valid; they are not valid before then
assert get_current_epoch(state) >= voluntary_exit.epoch

# Verify signature
domain = get_domain(state, DOMAIN_VOLUNTARY_EXIT, voluntary_exit.epoch)
signing_root = compute_signing_root(voluntary_exit, domain)
assert bls.Verify(validator.pubkey, signing_root, signed_voluntary_exit.signature)
```

So an old exit message can still be perfectly valid. The validator must be active, it must not already be exiting, it must have been active long enough, and the signature has to verify against the domain for the message epoch. There is no requirement that `voluntary_exit.epoch` be close to the current epoch.

I also cross-checked the raw Beacon API eventstream table against canonical block inclusion, because an eventstream row can always be a measurement surface rather than the chain surface. Deduping `beacon_api_eth_v1_events_voluntary_exit` by `(validator_index, epoch, signature)` over the same inclusion window produced **25,099** unique messages. Every one matched the canonical voluntary-exit table for the same `(validator_index, message_epoch, signature)`, and there were **0** event-only messages in that window.

```sql
WITH ev AS (
  SELECT validator_index, epoch AS message_epoch, signature
  FROM beacon_api_eth_v1_events_voluntary_exit
  WHERE meta_network_name = 'mainnet'
    AND wallclock_epoch_start_date_time >= toDateTime('2026-05-25 00:00:00')
    AND wallclock_epoch_start_date_time <  toDateTime('2026-06-25 00:00:00')
  GROUP BY validator_index, message_epoch, signature
), cb AS (
  SELECT
    voluntary_exit_message_validator_index AS validator_index,
    voluntary_exit_message_epoch AS message_epoch,
    voluntary_exit_signature AS signature
  FROM canonical_beacon_block_voluntary_exit
  WHERE meta_network_name = 'mainnet'
    AND slot_start_date_time >= toDateTime('2026-05-25 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-06-25 00:00:00')
  GROUP BY validator_index, message_epoch, signature
)
SELECT
  count() AS event_unique,
  countIf(cb.signature != '') AS matched_canonical_same_window,
  countIf(cb.signature = '') AS event_only,
  (SELECT count() FROM cb) AS canonical_unique
FROM ev
GLOBAL ANY LEFT JOIN cb USING (validator_index, message_epoch, signature);
```

Result: **25,099** eventstream uniques, **25,099** canonical uniques, **25,099** matches. The stale epoch shape is not a canonical-table artifact.

The clean mental model is simple: use `slot_start_date_time` or the canonical block `epoch` for when the exit happened. Use `voluntary_exit_message_epoch` only as the message's validity lower bound and signature-domain epoch. It is useful protocol data, but it is not an exit timestamp.

This is also why pre-signed exits leave such a distinct fingerprint. A service can hold an exit message signed months ago, then broadcast it when it actually wants the validator out. On chain, that looks like a modern inclusion carrying an old epoch. If your dashboard silently treats the message epoch as time, it will draw a neat chart of a thing that did not happen.
