---
slug: state-size-total-correction
title: "The state-size total I used was not the total"
description: "A correction to the February state graveyard post: fct_execution_state_size_daily.total_bytes was lower than the sum of its exposed components, and the corrected component total was 430.9 GB on Feb 26, not 295.9 GB."
authors: [aubury]
tags: [ethereum, state, correction, panda]
date: 2026-07-04
---

I owe this one a correction. In February I wrote that Ethereum was carrying **296 GB of state**. That was the value of `mainnet.fct_execution_state_size_daily.total_bytes`, but it was not the component total I described in the post.

On the same Feb 26 row, the exposed account, account-trie, contract-code, storage, and storage-trie byte columns add up to **430.9 GB**. Storage trie bytes alone were **220.8 GB**, so my old sentence saying "296 GB total" while also talking about trie bytes as part of that total was internally broken.

<!-- truncate -->

<img src="/img/state-size-total-correction.png" alt="Ethereum execution state-size correction showing fct_execution_state_size_daily total_bytes below the component sum and recent state churn nearly cancelling out" loading="eager" />

Here is the exact check that caught it. I am not doing anything clever here, just putting the table's `total_bytes` column next to the sum of the five byte components exposed in the same row.

```sql
SELECT
  day_start_date AS day,
  total_bytes,
  account_bytes,
  account_trienode_bytes,
  contract_code_bytes,
  storage_bytes,
  storage_trienode_bytes,
  account_bytes
    + account_trienode_bytes
    + contract_code_bytes
    + storage_bytes
    + storage_trienode_bytes AS component_sum_bytes,
  account_bytes
    + account_trienode_bytes
    + contract_code_bytes
    + storage_bytes
    + storage_trienode_bytes
    - total_bytes AS gap_bytes
FROM mainnet.fct_execution_state_size_daily FINAL
WHERE day_start_date IN (toDate('2026-02-26'), toDate('2026-07-02'))
ORDER BY day;
```

| day | `total_bytes` | component sum | gap |
| --- | ---: | ---: | ---: |
| 2026-02-26 | 295.912 GB | **430.932 GB** | 135.021 GB |
| 2026-07-02 | 316.606 GB | **460.532 GB** | 143.925 GB |

That is the correction: the February byte total in the old post should have been **430.9 GB** if the sentence means "sum the state-size components this table exposes." The current equivalent is **460.5 GB** as of the end of Jul 2. The dormant-storage-slot finding from that post still uses separate storage-slot tables and still survives, but the headline byte count and the "storage trie is part of this 296 GB" wording do not.

I cross-checked the component sum against the newer cumulative by-block table. First I resolved the canonical end-of-day execution blocks, then read the same five components at those block heights.

```sql
-- End-of-day block numbers from canonical_execution_block:
-- 2026-02-26 -> 24544538
-- 2026-07-02 -> 25448270

SELECT
  block_number,
  account_bytes
    + account_trienode_bytes
    + contract_code_bytes
    + storage_bytes
    + storage_trienode_bytes AS component_sum_bytes,
  account_bytes,
  account_trienode_bytes,
  contract_code_bytes,
  storage_bytes,
  storage_trienode_bytes
FROM mainnet.int_execution_state_size_by_block FINAL
WHERE block_number IN (24544538, 25448270)
ORDER BY block_number;
```

That returned the same component sums: **430,932,424,434 bytes** at block `24544538` and **460,531,564,066 bytes** at block `25448270`. This matters because `int_execution_state_size_by_block` is reconstructed from `execution_state_size_delta`, not just another view of the daily row I originally used.

The raw delta table also gives a nicer mental model for state growth. Over the seven complete UTC days from Jun 26 through Jul 2, mainnet did not simply "add two GB" in a quiet way. It wrote **144.23 GB** of state-size components and deleted **142.23 GB**, ending up about **2.00 GB** larger.

```sql
WITH per_block AS (
  SELECT
    block_number,
    argMax(
      account_bytes_delta
        + account_trienode_bytes_delta
        + contract_code_bytes_delta
        + storage_bytes_delta
        + storage_trienode_bytes_delta,
      updated_date_time
    ) AS total_bytes_delta,
    argMax(
      account_write_bytes
        + account_trienode_write_bytes
        + contract_code_write_bytes
        + storage_write_bytes
        + storage_trienode_write_bytes,
      updated_date_time
    ) AS gross_write_bytes,
    argMax(
      account_delete_bytes
        + account_trienode_delete_bytes
        + contract_code_delete_bytes
        + storage_delete_bytes
        + storage_trienode_delete_bytes,
      updated_date_time
    ) AS gross_delete_bytes,
    count() AS raw_rows,
    uniqExact(tuple(
      account_bytes_delta,
      account_trienode_bytes_delta,
      contract_code_bytes_delta,
      storage_bytes_delta,
      storage_trienode_bytes_delta
    )) AS metric_shapes
  FROM execution_state_size_delta
  WHERE meta_network_name = 'mainnet'
    AND block_number >= 25398083
    AND block_number <= 25448270
  GROUP BY block_number
)
SELECT
  count() AS blocks,
  sum(raw_rows) AS raw_rows,
  countIf(metric_shapes > 1) AS disagreement_blocks,
  sum(total_bytes_delta) AS raw_net_bytes,
  sum(gross_write_bytes) AS gross_write_bytes,
  sum(gross_delete_bytes) AS gross_delete_bytes,
  quantileExact(0.5)(total_bytes_delta) AS median_delta_bytes,
  countIf(total_bytes_delta < 0) AS shrinking_blocks
FROM per_block;
```

That query covered **50,188 canonical blocks** and **200,956 raw rows**, roughly four instrumented rows per block. Only **51 blocks** had component-shape disagreement across raw rows. Summing the deduped raw deltas gave **2,000,031,561 bytes** of net growth; the cumulative by-block endpoints gave **2,000,038,747 bytes**, a **7,186-byte** difference over the whole week. Close enough to trust the shape, but I use the endpoint number when I need the final net.

The more useful point is the cancellation. **2,868 blocks** in that week actually shrank the component sum, about **5.7%** of canonical blocks. The median block added only **23.2 KB**, while the gross write/delete streams moved two orders of magnitude more data than the net line suggests.

So the corrected story is messier, but better. Ethereum's exposed state-size components were about **431 GB** on the day of the old post and **461 GB** at the end of Jul 2. Recent growth is still a few hundred MB per day, but underneath that smooth net line is a churn machine writing and deleting roughly twenty GB of state components per day.

This is the kind of table footgun I like least: every column name sounds obvious until you add the columns.
