---
slug: eip7778-refunds-over-gas-limit
title: "At least 2,405 blocks ran over their gas limit before refunds"
description: "A correction and lower-bound EIP-7778 backcast: adding back only exactly reconstructable legacy refunds pushed 2.40% of 100,388 canonical blocks above their historical gas limits."
authors: aubury
tags: [ethereum, eip-7778, gas-refunds, glamsterdam, xen, data, correction]
date: 2026-08-24
---

I got one sentence wrong in the post I published earlier today. I wrote that a CoinTool XEN refund did not make its block cheaper because EIP-7778 already kept block gas accounting before refunds. [EIP-7778](https://eips.ethereum.org/EIPS/eip-7778) is scheduled for Glamsterdam, but it is not active on mainnet. Under today's rules, a refund lowers both the user's receipt gas and the gas counted in the block.

Adding the refund back changes the block story quite a lot. In the same 14 complete UTC days, **at least 2,405 of 100,388 canonical blocks carried more gas before refunds than their historical gas limit**. The worst reached a lower-bound **72.94 million gas against a 60 million limit**.

<!-- truncate -->

<img src="/img/eip7778-refunds-over-gas-limit.png" alt="Horizontal bars show the daily share of canonical Ethereum blocks whose lower-bound gas before refunds exceeded the historical gas limit from June 30 through July 13, 2026. The overall share was 2.40%, and the worst block reached 72.94 million gas against a 60 million limit." loading="eager" />

## The sentence I got wrong

The old post reconstructed one CoinTool call at **10,742,478 gas before refunds** and **8,593,983 gas in the receipt**. The 2,148,495-gas difference is the current one-fifth refund cap. I then wrote:

> It did not make the block cheaper; EIP-7778 already keeps block-level execution accounting before refunds.

That is backwards for the current chain. EIP-7778 exists because refunds currently reduce the gas used for block admission as well as the amount paid by the user. The proposal keeps the user refund but counts the block before that refund.

The distinction became hard to miss when [EIP-8141 PR #12226](https://github.com/ethereum/EIPs/pull/12226) merged on August 24. It added EIP-7778 as a dependency and changed frame-transaction block accounting to say exactly this: the payer is charged after the refund, while the block counts execution gas before the refund. EIP-8141 is Draft; EIP-7778 is Review and [Scheduled for Inclusion in Glamsterdam](https://eips.ethereum.org/EIPS/eip-7773). Glamsterdam still has no mainnet activation timestamp.

The XEN concentration in the earlier post survives. The claim about what today's block accounting does does not.

## Adding the refund back

I reused the exact window from the earlier post: blocks **25,426,767 through 25,527,154**, covering June 30 through July 13. The raw canonical block table returned 100,388 rows and 100,388 unique hashes. Its block hash, gas used and gas limit matched `mainnet.fct_block FINAL` on all 100,388 blocks, while the sum of 34,076,118 canonical transaction receipts matched raw block gas exactly. There were 32 empty blocks and no missing non-empty transaction aggregates.

I did not try to reconstruct every transaction type. That would require access-list and authorization-list fields that are not present in this transaction table. Instead I built a hard lower bound from the cohort I can reconstruct exactly: successful type-0 contract calls where the current calldata floor did not bind. A legacy call's intrinsic gas is `21,000 + 4 × zero calldata bytes + 16 × nonzero calldata bytes`, so its applied refund is exact intrinsic gas plus root execution gas minus receipt gas.

These are the two bounded queries I executed, followed by a one-to-one local join on block number:

```sql
-- Current canonical block accounting
SELECT
    b.block_number AS execution_block_number,
    any(b.block_date_time) AS block_time,
    any(b.block_hash) AS execution_block_hash,
    any(toUInt64(b.gas_used)) AS current_block_gas_used,
    any(b.gas_limit) AS current_block_gas_limit,
    count() AS source_rows,
    uniqExact(b.block_hash) AS unique_hashes
FROM default.canonical_execution_block AS b FINAL
WHERE b.meta_network_name = 'mainnet'
  AND b.block_number BETWEEN 25426767 AND 25527154
GROUP BY b.block_number
ORDER BY execution_block_number;

-- Exact applied refunds for the deliberately narrow legacy cohort
WITH exact_legacy AS
(
    SELECT
        r.block_number AS execution_block_number,
        toInt64(
            21000
            + 4 * t.n_input_zero_bytes
            + 16 * t.n_input_nonzero_bytes
        ) AS exact_intrinsic,
        exact_intrinsic + toInt64(r.gas_cumulative) AS pre_refund_gas,
        pre_refund_gas - toInt64(t.gas_used) AS applied_refund
    FROM
    (
        SELECT
            s.block_number,
            s.transaction_hash,
            s.gas_cumulative
        FROM default.canonical_execution_transaction_structlog_agg AS s FINAL
        WHERE s.meta_network_name = 'mainnet'
          AND s.block_number BETWEEN 25426767 AND 25527154
          AND s.operation = ''
          AND s.call_frame_id = 0
    ) AS r
    GLOBAL INNER JOIN
    (
        SELECT
            q.block_number,
            q.transaction_hash,
            q.gas_used,
            q.n_input_zero_bytes,
            q.n_input_nonzero_bytes
        FROM default.canonical_execution_transaction AS q FINAL
        WHERE q.meta_network_name = 'mainnet'
          AND q.block_number BETWEEN 25426767 AND 25527154
          AND q.transaction_type = 0
          AND q.to_address IS NOT NULL
          AND q.success
          AND q.gas_used > 21000
              + 10 * q.n_input_zero_bytes
              + 40 * q.n_input_nonzero_bytes
    ) AS t USING (block_number, transaction_hash)
)
SELECT
    execution_block_number,
    sum(toInt128(greatest(applied_refund, 0)))
        AS exact_applied_refund_gas
FROM exact_legacy
GROUP BY execution_block_number
ORDER BY execution_block_number;
```

The local calculation was intentionally plain:

```python
blocks = blocks.merge(refunds, on="execution_block_number", how="left",
                      validate="one_to_one")
blocks["exact_applied_refund_gas"] = (
    blocks["exact_applied_refund_gas"].fillna(0)
)
blocks["gross_lower_bound"] = (
    blocks["current_block_gas_used"]
    + blocks["exact_applied_refund_gas"]
)
over_limit = blocks[
    blocks["gross_lower_bound"] > blocks["current_block_gas_limit"]
]
```

| Measurement | Lower-bound result |
|---|---:|
| Canonical blocks | 100,388 |
| Canonical transactions | 34,076,118 |
| Exact legacy refunds added back | 9.484 billion gas |
| Blocks above their historical limit | 2,405, or 2.40% |
| Gas above those limits | 741.7 million |
| Largest single-block overage | 12.94 million gas |

Every day landed between **1.95% and 3.10%**. This was not one freak XEN burst propping up the headline.

## XEN still owns the ugly blocks

The block with the largest lower-bound overage was [25,508,080](https://etherscan.io/block/25508080). Its public RPC block hash matched both Xatu paths, and the RPC reported **59,996,677 gas used against a 60,000,000 limit**. Adding back exact refunds from only nine legacy calls produced **72,935,444 gas**, or 121.56% of the limit.

Six of those calls hit CoinTool's XEN Batch Minter. Together they supplied 12,890,976 of the block's 12,938,767 exact added gas, **99.63%**. Each of the six used roughly 10.74 million gas before its one-fifth refund and landed at about 8.59 million receipt gas. Under current accounting, that is how six giant calls fit beside the rest of the block.

The wider set was less absolute but still ugly. The 2,405 over-limit blocks contained 974.4 million gas of exactly reconstructed refunds. XEN Torrent and CoinTool supplied **618.7 million gas, or 63.5%**, while ordinary USDT transfers supplied another 105.8 million, or 10.9%. The contract labels came from `mainnet.dim_contract_owner FINAL`; the XEN selectors resolved through verified-contract rows in `mainnet.dim_function_signature FINAL`.

## A lower bound, not a fork simulation

The word "at least" matters. I omitted typed transactions, contract creations, failures and calldata-floor-bound calls. Any refundable work in those groups can only increase the gross-gas total reconstructed here. I also kept the current transaction set fixed, which no competent builder would do after EIP-7778 activates.

This is not a claim that Glamsterdam will produce invalid blocks or lose 2.40% of capacity. Builders will repack, users will change gas limits, and EIPs 7976, 8037 and 8038 change other parts of the gas schedule. It is a narrower observation: under today's rules, refunds hid enough already-performed gas to carry at least 2,405 recent blocks beyond the number printed as their limit.

That is precisely the capacity EIP-7778 stops giving back.
