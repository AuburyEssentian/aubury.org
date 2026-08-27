---
slug: gloas-ptc-present-payload-orphaned
title: "The PTC said present. Gloas still built as empty."
description: "On Glamsterdam devnet 8, 72 canonical child blocks skipped the parent execution payload after more than 256 PTC votes said it was present. A Prysm gas-limit fix shows why the execution hash matters separately from the beacon root."
authors: [aubury]
tags: [ethereum, gloas, prysm, devnet, xatu]
date: 2026-08-27
---

A Gloas Payload Timeliness Committee quorum sounds conclusive. It is not.

On Platåberget, I found **72 canonical child blocks that treated their beacon parent's execution payload as empty after more than 256 on-chain PTC votes said the payload was present**. Raw payload events show that every one of those parent payloads had arrived at at least 14 observer nodes. The beacon parent stayed in the canonical chain. Its execution payload did not.

This was rare, 72 cases out of 31,320 matched children with a present parent, or **0.2299%**. It was also real enough to happen three slots in a row. That distinction between beacon parent and execution parent is exactly where a Prysm bid-validation bug was hiding.

<!-- truncate -->

## One block, two parent identifiers

A Gloas payload bid carries both `parent_block_root` and `parent_block_hash`. The first identifies the beacon block being extended. The second identifies the exact execution payload the new bid builds on.

Those can point at different layers of the same history. If the hash matches the beacon parent's own payload, the child treats that parent as full. If it matches the older execution payload that the parent itself built on, the child treats the beacon parent as empty and keeps building from the older execution state.

The [Gloas state transition](https://github.com/ethereum/consensus-specs/blob/cf65c29a2590b8f5d43b6a26aee9f2293ed560f1/specs/gloas/beacon-chain.md#new-process_parent_execution_payload) is blunt about the choice:

```python
if bid.parent_block_hash != parent_bid.block_hash:
    # Parent was EMPTY
    assert requests == ExecutionRequests()
    return
```

The PTC votes feed payload timeliness and fork choice. They do not overwrite the execution hash chosen by the next canonical bid. A payload can arrive, collect a majority of present votes, and then lose to a child that builds on the empty version of the same beacon parent.

## Seventy-two full-voted payloads lost that branch choice

I joined every canonical child bid to its exact beacon parent, then joined the PTC aggregate that the child actually included. The `included_in_slot` and `included_in_block_root` predicates matter here. A loose join by attested root can attach the right vote to the wrong child.

This is the executed headline query. The window covers six complete UTC days, from August 21 through August 26.

```sql
WITH bids AS (
  SELECT
    slot,
    slot_start_date_time,
    block_root,
    block_hash,
    parent_block_root,
    parent_block_hash
  FROM `glamsterdam-devnet-8`.fct_block_payload_bid FINAL
  WHERE slot_start_date_time >= toDateTime('2026-08-20 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-27 00:00:00')
), votes AS (
  SELECT
    block_root,
    included_in_slot,
    included_in_block_root,
    payload_present_votes,
    status
  FROM `glamsterdam-devnet-8`.fct_block_payload_ptc_vote FINAL
  WHERE slot_start_date_time >= toDateTime('2026-08-20 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-27 00:00:00')
)
SELECT
  c.slot AS child_slot,
  c.block_root AS child_root,
  p.slot AS parent_slot,
  p.block_root AS parent_root,
  c.parent_block_hash AS chosen_execution_parent,
  p.block_hash AS parent_payload_hash,
  v.payload_present_votes
FROM bids AS c
INNER JOIN bids AS p
  ON c.parent_block_root = p.block_root
INNER JOIN votes AS v
  ON p.block_root = v.block_root
WHERE c.slot_start_date_time >= toDateTime('2026-08-21 00:00:00')
  AND c.slot_start_date_time <  toDateTime('2026-08-27 00:00:00')
  AND v.status = 'canonical'
  AND toUInt32(v.included_in_slot) = c.slot
  AND v.included_in_block_root = c.block_root
  AND v.payload_present_votes > 256
  AND c.parent_block_hash != p.block_hash
  AND c.parent_block_hash = p.parent_block_hash
ORDER BY c.slot
```

The broader join produced 31,488 matched canonical children. Of those, 31,320 had a parent with more than 256 payload-present votes. There were 233 canonical parent-as-empty children in total: 161 followed a parent that the PTC called absent, while **72 followed a parent that the PTC called present**.

The 72 were clustered. August 21 had 34, August 24 had 38, and the other four days had none. The present-vote count ranged from 262 to 450, with a median of 415. I found no more after slot 78,168 at 08:33:36 UTC on August 24, but I do not have a deployment clock that turns that stop into a fix claim.

<img src="/img/gloas-ptc-present-payload-orphaned.png" alt="Daily canonical parent-as-empty child counts split by whether the parent PTC aggregate said present or absent. Seventy-two present-voted parent payloads were skipped, including a three-payload run at slots 77,959 through 77,961." loading="eager" />

I cross-checked the exact 72 child roots against raw `canonical_beacon_block_execution_payload_bid` rows and the 72 parent roots against raw on-chain PTC positions. Every bid field and vote total matched the refined models. Raw `beacon_api_eth_v1_events_execution_payload` also contained one payload hash for every parent root, observed by 14 to 18 nodes.

## Three payloads arrived, got votes, and were all orphaned

The longest run was small enough to inspect without any aggregation. Child slots 77,960, 77,961, and 77,962 all reused the same older execution hash. Their immediate parent payloads, at slots 77,959 through 77,961, received 403, 351, and 262 present votes. The last one cleared the 256 threshold by six votes.

Platåberget's public Dora labels all three parent payloads `Orphaned`: [slot 77,959](https://dora.plataberget.ethpandaops.io/slot/77959), [slot 77,960](https://dora.plataberget.ethpandaops.io/slot/77960), and [slot 77,961](https://dora.plataberget.ethpandaops.io/slot/77961). The pages report 1,216, 1,669, and 2,028 transactions, respectively. That is **4,913 devnet transactions across three payloads that arrived, won PTC majorities, and still fell out of the execution chain**.

There is a useful model boundary here. `fct_block_payload` retained the correct revealed payload hashes and bid commitments for these roots, but its transaction fields were zero for the orphaned payloads. Dora exposed the transaction lists and gas used. I used the refined model for lineage, raw events for arrival, and Dora for the public payload-content check rather than pretending those zeros meant empty execution blocks.

At the final check, Dora rendered all 72 parent-slot pages and labelled every revealed payload `Orphaned`. This is the mirror image of the [empty-parent withdrawal loop](/blog/gloas-empty-parent-withdrawal-loop/): there the parent was PTC-absent and another miss followed; here the payload had a PTC majority but still lost the execution branch.

## Prysm asked the beacon root for an execution answer

Prysm [PR #17405](https://github.com/OffchainLabs/prysm/pull/17405), merged on August 26, fixed a validation bug on this exact seam. The old code looked up `GasLimit(parent_block_root)`. Once the root's own payload had arrived, that lookup returned the gas limit of that payload even when the bid's `parent_block_hash` pointed to the older full ancestor.

That is the wrong starting point for the EIP-1559 parent step. The bid gas limit must be checked against the execution payload it actually extends, using a maximum step of `parent_gas_limit / 1024 - 1`. The merged code now passes both the beacon root and the execution block hash, then rejects hashes that match neither the root's own payload nor its full parent.

The PR's concrete failure was slot 85,165. A parent-as-empty bid correctly stepped from gas limit 199,411,976 to 199,606,713 toward a 200 million target. Prysm instead compared 199,606,713 with the root's own payload, which already had the same gas limit, and expected another upward step. The valid bid came back as incompatible.

I ran a narrow backcast on the 72 canonical parent-as-empty cases using the 60 million and 200 million schedule endpoints that their gas-limit steps matched. All 72 matched one endpoint when calculated from the payload named by `parent_block_hash`. In **53 cases**, substituting the beacon root's own payload gas limit changed that compatible result into an incompatible one.

That 53 is a bug-surface count, not a historical Prysm rejection count. Client versions, proposer paths, and local target configuration decide whether a particular node exercised the broken lookup. What the data establishes is simpler: this was not defensive code for an imaginary branch. The devnet had already made that branch canonical dozens of times.

A PTC majority says the payload was timely enough to receive those votes. It does not make the payload execution-canonical. On Gloas, the next bid's execution parent hash can still throw it away, and any client code that collapses the root and hash into one parent will eventually get the wrong answer.
