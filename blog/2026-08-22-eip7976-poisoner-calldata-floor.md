---
slug: eip7976-poisoner-calldata-floor
title: "One executeBatch target takes 44% of EIP-7976's backcast"
description: "Across 14 complete days, one Xatu-labelled Poisoner executeBatch target supplies 30.01 billion of the 67.87 billion added gas in a fixed-path EIP-7976 backcast."
authors: [aubury]
tags: [ethereum, eip7976, eip7702, calldata, xatu, data]
date: 2026-08-22
---

A small [EIP-8141 text fix](https://github.com/ethereum/EIPs/pull/12209) landed on Friday. The frame-transaction draft had accidentally priced zero calldata bytes at 16 gas and nonzero bytes at 64; the intended EIP-7976 floor is 64 for both. Execution specs already counted the bytes correctly, so this was not a client fix or a live-network bug.

It did send me back to current mainnet calldata. Across the 14 complete UTC days from August 7 through August 20, one `executeBatch` target accounts for **30.01 billion of the 67.87 billion added gas** in a fixed-path EIP-7976 backcast. That is **44.22%** from one address, and 85.7% of the affected calldata bytes sent to it were zero.

<!-- truncate -->

[EIP-7976](https://eips.ethereum.org/EIPS/eip-7976) is in Review and [Scheduled for Inclusion in Glamsterdam](https://eips.ethereum.org/EIPS/eip-7773). It is not live. The proposal replaces EIP-7623's floor price of 10 gas for a zero byte and 40 for a nonzero byte with a uniform 64 gas per byte.

For a fixed historical execution path, the backcast is pleasantly blunt: `max(current receipt gas used, 21,000 + 64 × calldata bytes)`. The existing receipt already contains whichever was larger under today's rules, the normal execution path or the current calldata floor. Since 64/64 is never cheaper than 10/40, I only need to raise transactions whose new floor sits above their observed gas use.

I resolved the date window independently through refined and raw canonical block tables. Both returned blocks 25,699,362 through 25,799,779, with 100,418 blocks. The raw transaction path held 34,667,951 rows and the same number of unique hashes; refined daily transactions and canonical beacon payloads returned the same transaction count and exactly the same 3,047,594,700,486 gas.

Here is the executed reduction behind the headline:

```sql
WITH tx AS (
  SELECT
    transaction_type,
    lower(ifNull(to_address, '')) AS recipient,
    n_input_bytes,
    n_input_zero_bytes,
    gas_used,
    gas_limit,
    toUInt64(21000) + toUInt64(n_input_bytes) * 64 AS eip7976_floor,
    toUInt64(greatest(
      toInt64(toUInt64(21000) + toUInt64(n_input_bytes) * 64)
        - toInt64(gas_used),
      toInt64(0)
    )) AS added_gas
  FROM default.canonical_execution_transaction FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25699362 AND 25799779
)
SELECT
  multiIf(
    recipient = '0x00fe78205f5f0e63b8ad2b2ae5337f538a610e04',
      'Poisoner target',
    transaction_type = 4, 'other type-4',
    'other transactions'
  ) AS category,
  count() AS txs,
  countIf(added_gas > 0) AS affected_txs,
  countIf(added_gas > 0 AND gas_limit < eip7976_floor)
    AS old_limit_below_new_floor,
  sumIf(toUInt64(n_input_bytes), added_gas > 0) AS affected_input_bytes,
  sumIf(toUInt64(n_input_zero_bytes), added_gas > 0) AS affected_zero_bytes,
  sum(added_gas) AS total_added_gas
FROM tx
GROUP BY category
ORDER BY total_added_gas DESC;
```

The result has one absurdly loud row:

- Every transaction except the labelled target and other type-4 calls: 925,553 affected transactions, **37.74 billion** added gas.
- The target Xatu labels `Poisoner`: 70,317 affected transactions, **30.01 billion** added gas.
- Other type-4 transactions: 2,257 affected transactions, **120.49 million** added gas.

<img src="/img/eip7976-poisoner-calldata-floor.png" alt="Dark horizontal stacked bar chart showing daily fixed-path gas added by EIP-7976 from August 7 through August 20. One executeBatch target contributes 44.2% of the 14-day total, with daily shares ranging from 6.5% to 62.0%." loading="eager" />

The address is `0x00fe...0e04`, labelled `Poisoner` by the current contract-owner mapping. Every one of its 72,222 calls used selector `0x34fcd5be`, which the verified signature table maps to `executeBatch((address,uint256,bytes)[])`, and every call came from one sender. The envelope split was 64,159 type-4 transactions and 8,063 type-2 transactions, so this is not clean EIP-7702 adoption data even though type-4 dominates the row.

Of those calls, 70,317 hit the new floor. They carried 2.057 billion calldata bytes, including 1.762 billion zero bytes. The median fixed-path increase was 280,756 gas per affected call, while the total increase was 30.01 billion gas. EIP-7976 is doing exactly what it says here: a uniform byte price hits zero-heavy ABI-shaped calldata much harder than today's weighted floor.

This is not a new address. In the earlier [type-4 gas split](/blog/type4-poisoner-gas/), the same sender and target had 48,180 calls from June 20 through July 3. Re-running the same EIP-7976 formula on that frozen window gives 23.82 billion added gas over 2.113 billion input bytes. The recent window has 49.9% more calls but 2.0% fewer input bytes, so these are more, smaller batches rather than a fresh byte-volume explosion.

There are two hard boundaries on the result. First, 17,586 of the target's affected calls had a historical gas limit below the proposed floor. Those exact signed transactions would be invalid under EIP-7976 unless rebuilt with higher limits; they would not simply land and pay the delta shown here. Across the full sample, 232,320 affected transactions had that problem.

Second, this is not a block replay. Adding the fixed-path deltas makes 3,226 of 100,418 historical blocks exceed their then-current gas limits, and removing this one target drops that count to 2,931. Builders would change selection, senders would change limits, and some execution paths would change after repricing, so neither number predicts invalid Glamsterdam blocks.

The useful bit is the concentration. Only 2.88% of transactions in the window touch the higher floor, but one sender-target pair supplies almost half of the added gas. A network-wide affected-transaction percentage hides that shape. For rollout risk, the zero-byte producers and transactions whose old limits fall below the new floor are the rows worth watching.
