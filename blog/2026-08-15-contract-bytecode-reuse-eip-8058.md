---
slug: contract-bytecode-reuse-eip-8058
title: "Nine in ten contract deployments repeated old runtime code"
description: "Across 14 complete August days, 537,256 of 587,445 non-empty contract creations repeated runtime bytecode seen in an earlier block. Tiny proxies owned the count; 0.6% of repeats carried half the bytes."
authors: aubury
tags: [ethereum, execution, contracts, eip-8058, eip-8037, data]
date: 2026-08-15
---

Ethereum created **587,445 contracts with non-empty runtime code** in the first 14 complete days of August. **537,256 of them repeated runtime bytecode seen in an earlier block inside the same window.**

That is **91.5%**. The obvious culprit is the usual flood of 45-byte proxies, but those tiny contracts are only half the story. They own the address count; a few thousand large redeployments own the bytes that EIP-8058 is trying to stop charging twice.

<!-- truncate -->

<img src="/img/contract-bytecode-reuse-eip-8058.png" alt="Paired horizontal bars comparing the share of repeated contract deployments with the share of repeated runtime bytes by code-size bucket. Contracts over 5 kB are 0.6% of repeats but 49.7% of repeated bytes." loading="eager" />

I hit a data trap before I got to the result. `canonical_execution_contracts.code_hash` is documented as the deployed code hash, so it looks like the natural grouping key. It is not.

In the current Cryo source, `init_code_hash` hashes `result.code`, while `code_hash` hashes `create.init`. The assignments are backwards, and [the fix has been sitting in an open PR since February](https://github.com/paradigmxyz/cryo/pull/249). The live data makes the bug hard to miss: one supposed `code_hash` grouped **386 different runtime byte strings**. Grouping by `init_code_hash` produced zero runtime disagreements across 48,865 hashes in this window.

So the ugly honest label in the query is `init_code_hash AS runtime_hash`. I also throw away every runtime's first block in the window. A same-block deployment may not exist when an earlier transaction's access set is built, and code that existed before August is outside this scan. What remains is a conservative count of code that definitely appeared in a previous block during these 14 days.

```sql
WITH marked AS (
  SELECT
    block_number,
    transaction_hash,
    internal_index,
    init_code_hash AS runtime_hash, -- currently holds keccak(runtime code)
    n_code_bytes,
    min(block_number) OVER (
      PARTITION BY init_code_hash
    ) AS first_block_in_window
  FROM default.canonical_execution_contracts FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25656293 AND 25756720
    AND n_code_bytes > 0
)
SELECT
  count() AS nonempty_runtime_deployments,
  countIf(block_number > first_block_in_window)
    AS prior_block_same_runtime_deployments,
  round(
    100 * prior_block_same_runtime_deployments
        / nonempty_runtime_deployments,
    3
  ) AS prior_block_share_pct,
  uniqExactIf(runtime_hash, block_number > first_block_in_window)
    AS repeated_runtime_hashes,
  uniqExactIf(transaction_hash, block_number > first_block_in_window)
    AS deployment_transactions,
  sumIf(toUInt128(n_code_bytes), block_number > first_block_in_window)
    AS repeated_runtime_bytes
FROM marked;
```

That returned **537,256 prior-block repeats**, spread across **2,214 exact runtime hashes** and **84,154 deployment transactions**. The repeated runtime added up to **82,490,738 bytes**. This is repetition in canonical execution traces, not a count of live state entries or unique applications.

The independent creation model agreed on the outer denominator. `mainnet.int_contract_creation FINAL` returned **602,779 semantic creation rows** and **599,765 contract addresses** for the same literal block range. The raw contract table returned the same 602,779 rows; 15,334 had empty runtime code, leaving the 587,445 used above.

```sql
SELECT
  count() AS rows,
  uniqExact(tuple(block_number, transaction_hash, internal_index))
    AS semantic_creations,
  uniqExact(contract_address) AS contract_addresses
FROM mainnet.int_contract_creation FINAL
WHERE block_number BETWEEN 25656293 AND 25756720;
```

The count side is almost comically repetitive. An exact match for the standard ERC-1167 runtime shape found **475,946 minimal proxies**, or **88.6% of the prior-block repeats**. This is the same factory-heavy mess I found in the [June XEN contract flood](/blog/xen-clone-factory/), not half a million new applications.

```sql
SELECT
  count() AS prior_block_same_runtime_deployments,
  countIf(match(
    lower(code),
    '^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$'
  )) AS exact_erc1167_runtime
FROM (
  SELECT
    block_number,
    init_code_hash AS runtime_hash,
    code,
    min(block_number) OVER (
      PARTITION BY init_code_hash
    ) AS first_block_in_window
  FROM default.canonical_execution_contracts FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25656293 AND 25756720
    AND n_code_bytes > 0
)
WHERE block_number > first_block_in_window;
```

But EIP-8058 discounts code deposit by byte length, not by how many addresses appeared. That flips the picture. Runtime code above 5 kB was only **3,465 deployments**, or **0.6%** of the repeat cohort, but it carried **41,000,400 bytes: 49.7% of all repeated runtime bytes**.

```sql
SELECT
  multiIf(
    n_code_bytes <= 45, '<=45 B',
    n_code_bytes <= 100, '46-100 B',
    n_code_bytes <= 1000, '101-1000 B',
    n_code_bytes <= 5000, '1-5 kB',
    n_code_bytes <= 15000, '5-15 kB',
    '>15 kB'
  ) AS size_bucket,
  count() AS prior_block_same_runtime_deployments,
  sum(toUInt128(n_code_bytes)) AS repeated_runtime_bytes
FROM marked
WHERE block_number > first_block_in_window
GROUP BY size_bucket;
```

At today's 200 gas per deposited code byte, that 82.49 MB cohort represents **16.50 billion code-deposit gas**. The current [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037) text uses `CPSB = 1,530`, which turns the same bytes into **126.21 billion state gas** before any EIP-8058 discount. That is a straight backcast, not a fee forecast: EIP-8037 introduces a separate state-gas dimension, and the workload will change if deployment gets 7.65 times more expensive per byte.

There is another bit of proposal drift here. [EIP-8058](https://eips.ethereum.org/EIPS/eip-8058) still says 1,900 gas per byte, but its dependency now says 1,530. I used 1,530. EIP-8058 is Draft, EIP-8037 is Review, and the [PR proposing EIP-8058 for Hegotá](https://github.com/ethereum/EIPs/pull/11894) is still open. None of this is scheduled for mainnet.

The 91.5% is not an eligibility rate either. EIP-8058 only waives the deposit when the transaction's access list names a live contract with the same runtime hash. This table does not expose access lists, and prior creation does not prove that a usable account was live at every later deployment. The query proves how much bytecode was repeated, then stops.

That is enough to change the shape of the argument. Tiny proxies make Ethereum look like it is creating an absurd number of contracts. Large repeated runtimes, though rare, carry half of the duplicate byte bill.

Ethereum creates many new addresses. It creates much less new code.
