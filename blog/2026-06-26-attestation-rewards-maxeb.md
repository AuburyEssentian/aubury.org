---
slug: attestation-rewards-maxeb
title: Attestation rewards still know how big the validator is
description: In 172 deduped reward epochs, 1024-2048 ETH validators were 0.66% of active indices but took 26.13% of attestation rewards.
authors: aubury
tags: [ethereum, staking, maxeb, electra, data]
date: 2026-06-26
---

The last MaxEB committee post had an uncomfortable-looking number: large validators were about **25.6%** of active effective stake, but only **0.65%** of ordinary attestation committee positions. That sounds like the accounting forgot the stake.

It did not. The committee assignment surface counts validator indices. The reward surface remembers the balance.

<!-- truncate -->

<figure>
  <a href="/img/attestation-rewards-maxeb.png"><img src="/img/attestation-rewards-maxeb.png" alt="Dark two-panel chart showing that large MaxEB validators are 0.66 percent of active validator indices but 26.13 percent of active effective stake and attestation rewards. A second panel shows a 2048 ETH validator earning 64 times the median attestation reward of a 32 ETH validator over the same window." loading="eager" /></a>
  <figcaption>Source: Xatu raw <code>canonical_beacon_attestation_reward</code>, deduped by <code>(epoch, validator_index)</code>, joined locally to <code>mainnet.fct_validator_balance_daily FINAL</code> for 2026-06-25 balances. Window: 172 observed reward epochs from 2026-06-25 05:04 to 2026-06-26 03:54 UTC.</figcaption>
</figure>

This is a follow-up to the [ordinary attestation committee count post](/blog/attestation-committees-maxeb-count/), not a correction to it. `get_beacon_committee` still shuffles active validator indices. A 2,048 ETH validator gets one ordinary attestation duty in an epoch, just like a 32 ETH validator gets one duty. That part is still index-count based.

The newly exposed reward table gives the other half of the story. Altair's `get_base_reward` uses effective-balance increments, and the attestation flag deltas multiply from that base reward. In plain terms: once the validator is assigned to a committee, the reward math scales with its effective balance.

I checked the first usable mainnet window in the new table: 2026-06-25 05:04 through 2026-06-26 03:54 UTC. The raw table had duplicate ingestion rows in a few epochs, so I grouped by `(epoch, validator_index)` and kept the latest value before adding anything up. Then I joined the reward totals to the daily validator balance table with `FINAL`, because that table can otherwise double-count replacement rows.

The query shape looked like this:

```python
from ethpandaops import clickhouse

START = "2026-06-25 05:00:00"
END = "2026-06-26 04:00:00"
BAL_DAY = "2026-06-25"

rewards = clickhouse.query("clickhouse-raw", f"""
SELECT
  validator_index,
  count() AS epochs_seen,
  sum(head) AS head_gwei,
  sum(target) AS target_gwei,
  sum(source) AS source_gwei,
  sum(inclusion_delay) AS inclusion_gwei,
  sum(inactivity) AS inactivity_gwei,
  sum(head + target + source + inclusion_delay + inactivity) AS total_gwei
FROM (
  SELECT
    epoch,
    validator_index,
    argMax(head, updated_date_time) AS head,
    argMax(target, updated_date_time) AS target,
    argMax(source, updated_date_time) AS source,
    argMax(ifNull(toInt64(inclusion_delay), 0), updated_date_time) AS inclusion_delay,
    argMax(inactivity, updated_date_time) AS inactivity
  FROM canonical_beacon_attestation_reward
  WHERE meta_network_name = 'mainnet'
    AND epoch_start_date_time >= toDateTime('{START}')
    AND epoch_start_date_time < toDateTime('{END}')
  GROUP BY epoch, validator_index
)
GROUP BY validator_index
""")

balances = clickhouse.query("clickhouse-refined", f"""
SELECT validator_index, effective_balance, status
FROM mainnet.fct_validator_balance_daily FINAL
WHERE day_start_date = toDate('{BAL_DAY}')
  AND effective_balance IS NOT NULL
""")
```

After the join, the active matched set had **886,380** validators. The big bucket, `1024-2048 ETH`, had only **5,880** of them. That is **0.663%** of active validator indices, almost exactly the same tiny count share as the ordinary committee post found.

But those 5,880 validators carried **10.450M ETH** of effective balance, or **26.130%** of active effective stake in the matched set. They received **26.134%** of the attestation rewards in the window. The reward share sat on top of the stake share so closely that the line is boring, which is the point.

| effective-balance bucket | active validators | validator index share | active effective stake | stake share | attestation reward share |
|---|---:|---:|---:|---:|---:|
| 32-ish | 875,154 | 98.7335% | 28.004M ETH | 70.0214% | 70.0153% |
| 33-127 | 2,406 | 0.2714% | 144,080 ETH | 0.3603% | 0.3583% |
| 128-1023 | 2,940 | 0.3317% | 1.395M ETH | 3.4884% | 3.4927% |
| 1024-2048 | 5,880 | 0.6634% | 10.450M ETH | 26.1300% | 26.1337% |

The per-validator number makes the mechanism harder to miss. In the same window, an exact 32 ETH validator had a median total attestation reward of **0.001476 ETH**. An exact 2,048 ETH validator had **0.094480 ETH**. That is **64.0x**, which is exactly the balance ratio.

So the split is not "committees forgot stake" versus "rewards remembered stake" in some vague way. It is two different surfaces. Committee position count tells you how many validator indices had to run the duty. Reward and vote-weight accounting tells you how much effective balance those indices carried.

That distinction matters because MaxEB makes the old shortcuts fail in both directions. If you are estimating gossip load, API row volume, or ordinary committee position counts, a 2,048 ETH validator is still one validator index. If you are estimating attestation rewards, economic weight, or finality weight, it is not one old validator. It is up to sixty-four of them wearing one index.

The caveat is small but worth keeping in the query. This reward table only started filling recently, and the window here is the first 172 observed reward epochs, not a trend. Also, the first day of rows had a few duplicate `(epoch, validator_index)` entries with identical reward values. Dedupe first, then ask the question.
