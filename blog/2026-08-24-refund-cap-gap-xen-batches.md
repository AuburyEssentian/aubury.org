---
slug: refund-cap-gap-xen-batches
title: "The refund-cap gap was 91% XEN batches"
description: "EIP-3298 became Draft with a plan to delete Ethereum's refund cap. In the latest complete Xatu structlog window, 895 XEN batch calls made 90.9% of the 1.58 billion-gas counter-to-receipt gap."
authors: aubury
tags: [ethereum, eip-3298, gas-refunds, sstore, xen, data]
date: 2026-08-24
---

[EIP-3298](https://eips.ethereum.org/EIPS/eip-3298) came back from Stagnant and became Draft on August 19. It removes the storage-clear refund and the current 20% transaction refund cap after EIPs 8037 and 8038, while keeping same-transaction write reversals. I expected the current cap to catch a broad mix of refund-heavy Ethereum calls.

Instead, **895 calls into two XEN batch-minter contracts made 90.9% of the gap** between the peak refund counter and the refund that actually reached transaction receipts.

<!-- truncate -->

<img src="/img/refund-cap-gap-xen-batches.png" alt="In an exact 1.92 million-transaction legacy cohort from June 30 through July 13, 2026, XEN Torrent made 67.8% and CoinTool XEN made 23.1% of the 1.58 billion-gas gap between peak refund counters and receipt-applied refunds; 99.88% of the gap was on cap-binding calls" loading="eager" />

## The cap barely binds, then binds hard

The structlog aggregate currently ends partway through July 14, so this is not live August activity. I used its latest 14 complete UTC days, June 30 through July 13, covering blocks **25,426,767–25,527,154**. The raw canonical block table returned 100,388 rows, 100,388 unique block numbers, and 100,388 unique hashes across the same literal bounds.

I narrowed the measurement to successful, non-creation type-0 transactions whose calldata floor did not bind. That is deliberately boring. A legacy call has no access list or EIP-7702 authorization cost, so its protocol intrinsic gas is exactly `21,000 + 4 × zero calldata bytes + 16 × nonzero calldata bytes`. The refund visible at settlement is then `exact intrinsic + root execution gas - receipt gas`.

This is the query I ran against the full range after checking the result day by day:

```sql
WITH cohort AS
(
    SELECT
        r.transaction_hash AS tx_hash,
        r.gas_refund AS peak_refund,
        r.gas_cumulative AS execution_gas,
        r.intrinsic_gas AS stored_intrinsic,
        toInt64(
            21000
            + 4 * t.n_input_zero_bytes
            + 16 * t.n_input_nonzero_bytes
        ) AS exact_intrinsic,
        toInt64(exact_intrinsic) + toInt64(r.gas_cumulative)
            AS pre_refund_gas,
        pre_refund_gas - toInt64(t.gas_used) AS applied_refund,
        intDiv(pre_refund_gas, 5) AS refund_cap
    FROM
    (
        SELECT
            block_number,
            transaction_hash,
            gas_refund,
            gas_cumulative,
            intrinsic_gas
        FROM default.canonical_execution_transaction_structlog_agg
        WHERE meta_network_name = 'mainnet'
          AND block_number BETWEEN 25426767 AND 25527154
          AND operation = ''
          AND call_frame_id = 0
    ) AS r
    GLOBAL INNER JOIN
    (
        SELECT
            block_number,
            transaction_hash,
            gas_used,
            n_input_zero_bytes,
            n_input_nonzero_bytes
        FROM default.canonical_execution_transaction FINAL
        WHERE meta_network_name = 'mainnet'
          AND block_number BETWEEN 25426767 AND 25527154
          AND transaction_type = 0
          AND to_address IS NOT NULL
          AND success
          AND gas_used > 21000
              + 10 * n_input_zero_bytes
              + 40 * n_input_nonzero_bytes
    ) AS t USING (block_number, transaction_hash)
)
SELECT
    count() AS transactions,
    countIf(peak_refund > 0) AS positive_counter,
    countIf(applied_refund = refund_cap AND applied_refund > 0)
        AS cap_binding,
    countIf(
        applied_refund < refund_cap
        AND peak_refund > toUInt64(applied_refund)
    ) AS peak_fell_before_settlement,
    countIf(toInt64(stored_intrinsic) != exact_intrinsic)
        AS bad_stored_intrinsic,
    countIf(
        applied_refund < 0
        OR applied_refund > refund_cap
        OR peak_refund < toUInt64(applied_refund)
    ) AS invalid_rows,
    sum(toUInt128(peak_refund)) AS peak_counter_gas,
    sum(toInt128(applied_refund)) AS applied_refund_gas,
    sum(toInt128(peak_refund) - toInt128(applied_refund))
        AS counter_to_receipt_gap,
    sumIf(
        toInt128(peak_refund) - toInt128(applied_refund),
        applied_refund = refund_cap AND applied_refund > 0
    ) AS cap_binding_gap
FROM cohort
```

| Measurement | Result |
|---|---:|
| Exact legacy-call cohort | 1,917,264 transactions |
| Positive peak refund counter | 982,031 transactions |
| Current 20% cap binding | 11,432 transactions |
| Peak refund counters | 11.063 billion gas |
| Refund applied to receipts | 9.484 billion gas |
| Counter-to-receipt gap | 1.580 billion gas |
| Gap on cap-binding calls | 1.578 billion gas, 99.88% |
| Invalid settlement identities | 0 |

Only **1.16%** of calls with a positive refund counter hit the cap. When they did, they were huge: 11,432 capped calls accounted for nearly all of the 1.58 billion-gas gap. Another 424 uncapped calls had a peak counter above their final applied refund, but those counter reversals contributed only 1.84 million gas, or 0.12% of the gap.

## XEN sat on the choke point

I carried the transaction target and four-byte selector through the same daily queries, then grouped the bounded results locally. The top row was [XEN Torrent](https://etherscan.io/address/0x0a252663dbcc0b073063d6420a40319e438cfa59) calling `bulkClaimMintReward(uint256,address)`: **737 calls and 1.071 billion gas**, or 67.81% of the whole gap. [CoinTool's XEN Batch Minter](https://etherscan.io/address/0x0de8bf93da2f7eecb3d9169422413a9bef4ef628) added **158 calls and 364.5 million gas**, another 23.07%.

Everything else in the 1.92 million-call cohort contributed 144.1 million gas. The contract labels came from `mainnet.dim_contract_owner FINAL`; the selectors `0xf5878b9b` and `0xc2580804` both resolved through verified-contract rows in `mainnet.dim_function_signature FINAL`.

One CoinTool transaction makes the settlement easy to see. [Transaction `0xdf03…d6fca`](https://etherscan.io/tx/0xdf03ade825f6d31cb8e7b1ed056174d37c84d5aa982ff849e020f75bb22d6fca) had 53,964 intrinsic gas and 10,688,514 execution gas, for **10,742,478 gas before refunds**. One fifth is 2,148,495 gas. Its public receipt and the canonical transaction table both report **8,593,983 gas used**, exactly `10,742,478 - 2,148,495`, while the trace's peak refund counter reached 4.8 million gas.

The peak-to-receipt gap was 2,651,505 gas in that one call. It did not make the block cheaper; [EIP-7778](https://eips.ethereum.org/EIPS/eip-7778) already keeps block-level execution accounting before refunds.

## This is not an EIP-3298 backcast

It would be tempting to call the 1.58 billion-gas gap "extra refunds after EIP-3298." That would be wrong. The proposal lifts the cap only after deleting the future 11,616-gas storage-clear refund, while retaining the EIP-8038 write-reversal refund. Today's peak counter does not tell me which entries survive that rewrite, and the proposal still applies the calldata floor after settlement.

There is a second trap in this table. Its [`gas_refund` is the maximum counter seen during the trace](https://github.com/ethpandaops/execution-processor/blob/c44422d278a1c28e051ba8c7caaf98460346e52a/pkg/processor/transaction/structlog_agg/aggregator.go), not a promise that the whole value reached the receipt. Worse, the stored `intrinsic_gas` in this historical snapshot disagreed with the exact type-0 formula on **all 982,031 positive-counter rows**. I recomputed intrinsic gas instead of trying to repair that column.

EIP-3298 may still be a clean simplification. But the current cap was not a broad brake on every refunding application in this window. It was a narrow choke point with two XEN batch minters sitting on it.
