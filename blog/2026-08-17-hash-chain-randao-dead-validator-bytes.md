---
slug: hash-chain-randao-dead-validator-bytes
title: "Hash-chain RANDAO would reserve 46 MB for dead validator indices"
description: "A current-state backcast of draft EIP-8321 finds a 74.75 MB raw SSZ commitment-list body, with 61.5% indexed by validators that can never propose again."
authors: aubury
tags: [ethereum, consensus, randao, validators, eip-8321, panda]
date: 2026-08-17
---

[EIP-8321](https://eips.ethereum.org/EIPS/eip-8321) sounds almost suspiciously cheap. Replace the BLS RANDAO reveal with a hash chain, then store only the validator's current 32-byte commitment. The per-validator number is tiny. The validator registry is not.

Backcast against mainnet at finalized epoch 469,034, the proposed list body is 74.75 MB in raw SSZ. Of that, 45.98 MB points at validator indices that have already exited and can never propose again. The fork transition would initialize every one of those entries to zero, and the old indices have no proposal duty that needs a commitment.

<!-- truncate -->

![A current-state backcast of EIP-8321's commitment list. The 74.75 MB raw SSZ body is split into 28.77 MB for active or pending validators and 45.98 MB for permanently non-proposing indices. The existing RANDAO mix vector is 2.10 MB.](/img/hash-chain-randao-dead-validator-bytes.png)

## The field is dense even when the value is zero

The [merged draft](https://github.com/ethereum/EIPs/blob/bd90171e51aabafad9043b8b47acdb6e6eb724f6/EIPS/eip-8321.md) adds `randao_commitments: List[Bytes32, VALIDATOR_REGISTRY_LIMIT]` to `BeaconState`. The text is explicit: the list is indexed by validator index, holds one entry per registry member, and uses the zero word when no commitment is registered.

That makes the raw size boring to calculate: `validator registry length × 32 bytes`. A list of fixed-size `Bytes32` elements has no per-element offsets to save. Zero values may compress well on the wire, and clients may avoid a naive in-memory layout, but the uncompressed protocol-visible list body still contains all 32 bytes for every index. The numbers here are not a bandwidth or RAM estimate.

For scale, the current `randao_mixes` vector contains 65,536 `Bytes32` values, or 2.10 MB. The proposed commitment list would be 35.6 times larger against this state.

## The registry is mostly graves

I froze one exact canonical state rather than mixing validator snapshots from different epochs. This is the headline query, run against raw Xatu data:

```sql
SELECT
    epoch AS state_epoch,
    any(epoch_start_date_time) AS state_time,
    count() AS rows,
    uniqExact(index) AS validator_indices,
    min(index) AS min_index,
    max(index) AS max_index,
    countIf(status LIKE 'active_%') AS active_indices,
    countIf(status LIKE 'pending_%') AS pending_indices,
    countIf(
        status LIKE 'exited_%'
        OR status LIKE 'withdrawal_%'
    ) AS permanently_nonproposing_indices,
    countIf(status = 'withdrawal_done') AS withdrawal_done_indices,
    sum(toUInt128(ifNull(effective_balance, 0))) AS effective_balance_gwei,
    countIf(ifNull(balance, 0) = 0) AS zero_balance_indices,
    countIf(slashed) AS slashed_indices
FROM default.canonical_beacon_validators FINAL
WHERE meta_network_name = 'mainnet'
  AND epoch = 469034
  AND epoch_start_date_time = toDateTime('2026-08-17 02:17:59')
GROUP BY epoch
```

It returned 2,335,892 rows and exactly 2,335,892 unique indices, running continuously from 0 through 2,335,891. That grain check matters. There is no observer multiplier hiding in the total.

The status split was:

- 897,989 active indices;
- 1,134 pending indices;
- 1,436,769 exited or withdrawable indices that cannot propose again.

The last bucket is 61.51% of the registry. It includes 1,435,825 validators in `withdrawal_done`, all with zero balance in this state. Multiplying the buckets by 32 gives 28.77 MB for active or pending validators and 45.98 MB for permanently non-proposing indices.

Validator indices are not recycled. An old validator cannot wake up under its old index; re-entry creates another registry member. EIP-8321 needs direct lookup by validator index, so its dense list inherits every grave in that registry and every new one added later.

There is one odd wrinkle in the current draft: registration checks the signature and index, but not whether the validator is active. An exited validator could technically replace its zero with a commitment it will never reveal. That changes the bytes, not the state cost or the validator's role in RANDAO.

## Two checks before trusting it

The refined daily table landed within 20 validators of the later raw state. At the end of August 16, `mainnet.fct_validator_balance_daily FINAL` had 2,335,872 unique indices, including 897,967 active and 1,436,759 exited or withdrawable. The small difference is ordinary registry movement between the daily snapshot and epoch 469,034, not a disagreement in scale.

I also checked raw epochs 469,033 through 469,035. Each returned the same 2,335,892 unique indices and the same active/permanently-non-proposing split. A public Beacon API had finalized epoch 469,038 when I verified the state, so epoch 469,034 was safely behind finality.

The registration cap does not make this an onboarding-capacity story. EIP-8321 permits up to 128 commitment registrations per block; at the theoretical maximum, today's active and pending set fits in just under one day of blocks. Filling those live entries does nothing to remove the 1.44 million old slots.

EIP-8321 is a Draft with no scheduled fork. Its hash-chain construction is trying to remove a real post-quantum weakness in RANDAO without replacing it with a grindable signature. That part is interesting. But "only 32 bytes per validator" is not a small-state sentence on today's beacon chain.

Most of the new field would be reserved for validators that are gone for good, whether their useless entries stayed zero or not.
