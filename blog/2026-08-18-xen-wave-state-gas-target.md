---
slug: xen-wave-state-gas-target
title: "One XEN wave would eat 69% of a day's state-gas target"
description: "On August 16, 5,747 XEN transactions netted 1.465 million storage slots, 73.7% of Ethereum's daily growth. The EIP-8037 storage-set charge alone backcasts to 149.25 billion state gas."
authors: aubury
tags: [ethereum, state, storage, xen, eip-8037, eip-8372, xatu]
date: 2026-08-18
---

Ethereum added just under two million net storage slots on August 16. XEN Crypto was responsible for **1,464,993 of them**.

That came from 5,747 transactions, only **0.31%** of the day's transaction count. They used **26.3%** of execution gas and left behind **73.7%** of the net slot growth. Under the constants in [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037), the XEN storage writes alone backcast to **149.25 billion state gas**, or **69.2%** of that day's 50% state-gas target at the observed block limits.

<!-- truncate -->

<img src="/img/xen-wave-state-gas-target.png" alt="Dark chart comparing all Ethereum storage-slot transitions with the XEN subset on August 16, 2026. XEN accounts for 1.524 million of 2.384 million creations, 59,242 of 396,203 deletions, and 1.465 million of 1.987 million net new slots. A callout shows the EIP-8037 storage-set charge backcasting to 149.25 billion state gas, 69.2% of the day's target at observed block limits." loading="eager" />

XEN being Ethereum's largest storage tenant is old news. I have already written about its giant slot footprint, its clone factories, and a bogus reactivation spike that turned out to be model-write time. This is a different clock and a different question: what does one current XEN wave look like when the protocol is considering a separate meter for state creation?

## The count

I froze the complete UTC day through the execution block timestamp index first. August 16 contained **7,186 canonical blocks**, from **25,763,888 through 25,771,073**.

```sql
SELECT
  min(block_number) AS min_block,
  max(block_number) AS max_block,
  count() AS blocks
FROM mainnet.int_execution_block_by_date FINAL
WHERE block_date_time >= toDateTime64('2026-08-16 00:00:00', 3)
  AND block_date_time <  toDateTime64('2026-08-17 00:00:00', 3);
```

The storage-diff row grain is one transaction-level state transition keyed by `(block_number, transaction_hash, internal_index)`. The raw table had **6,378,924 rows and 6,378,924 unique keys** in the range, so there was no observer multiplier hiding in the count.

```sql
SELECT
  count() AS rows,
  uniqExact((block_number, transaction_hash, internal_index)) AS semantic_rows,

  countIf(match(from_value, '^0x0*$') AND NOT match(to_value, '^0x0*$')) AS all_created,
  countIf(NOT match(from_value, '^0x0*$') AND match(to_value, '^0x0*$')) AS all_cleared,
  all_created - all_cleared AS all_net,

  countIf(
    lower(address) = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8'
    AND match(from_value, '^0x0*$') AND NOT match(to_value, '^0x0*$')
  ) AS xen_created,
  countIf(
    lower(address) = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8'
    AND NOT match(from_value, '^0x0*$') AND match(to_value, '^0x0*$')
  ) AS xen_cleared,
  xen_created - xen_cleared AS xen_net,
  uniqExactIf(
    transaction_hash,
    lower(address) = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8'
  ) AS xen_transactions
FROM default.canonical_execution_storage_diffs FINAL
WHERE meta_network_name = 'mainnet'
  AND block_number BETWEEN 25763888 AND 25771073;
```

The raw result was **2,383,587 slot creations and 396,203 clears** across Ethereum, for a net increase of **1,987,384**. XEN created **1,524,235**, cleared **59,242**, and netted **1,464,993** across 5,747 transaction hashes. That is 73.71% of the raw net.

I cross-checked the ending state through the refined daily model rather than trusting one event path. It returned **1,987,071** net new slots for Ethereum and the same **1,464,993** for XEN, putting the share at 73.73%. The two global paths differ by 313 slots, or 0.016%; the headline stays **73.7%** instead of pretending the last basis point matters.

```sql
WITH global_state AS (
  SELECT
    day_start_date,
    storages - lagInFrame(storages) OVER (ORDER BY day_start_date) AS net_slots
  FROM mainnet.fct_execution_state_size_daily FINAL
  WHERE day_start_date BETWEEN toDate('2026-08-15') AND toDate('2026-08-16')
), xen_state AS (
  SELECT
    day_start_date,
    active_slots - lagInFrame(active_slots) OVER (ORDER BY day_start_date) AS net_slots
  FROM mainnet.fct_contract_storage_state_by_address_daily FINAL
  WHERE address = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8'
    AND day_start_date BETWEEN toDate('2026-08-15') AND toDate('2026-08-16')
)
SELECT
  day_start_date,
  global_state.net_slots AS global_net_slots,
  xen_state.net_slots AS xen_net_slots,
  xen_net_slots / toFloat64(global_net_slots) AS xen_share
FROM global_state
INNER JOIN xen_state USING (day_start_date)
WHERE day_start_date = toDate('2026-08-16');
```

## It was batch tooling

The 5,747 hashes were not 5,747 ordinary users each poking one mapping entry. I fetched the XEN-touching hash cohort first, queried canonical root transactions in literal batches, and joined them locally. All **5,747 hashes matched**, all had successful root receipts, and just **442 root senders** generated the cohort.

```python
import pandas as pd

xen = clickhouse.query("clickhouse-raw", """
SELECT
  d.transaction_hash,
  any(d.block_number) AS tx_block_number,
  countIf(match(d.from_value, '^0x0*$') AND NOT match(d.to_value, '^0x0*$')) AS creates,
  countIf(NOT match(d.from_value, '^0x0*$') AND match(d.to_value, '^0x0*$')) AS clears
FROM default.canonical_execution_storage_diffs AS d FINAL
WHERE d.meta_network_name = 'mainnet'
  AND d.block_number BETWEEN 25763888 AND 25771073
  AND lower(d.address) = '0x06450dee7fd2fb8e39061434babcfc05599a6fb8'
GROUP BY d.transaction_hash
""")

parts = []
hashes = xen.transaction_hash.tolist()
for i in range(0, len(hashes), 700):
    batch = hashes[i:i + 700]
    literals = ",".join("'" + h + "'" for h in batch)
    parts.append(clickhouse.query("clickhouse-raw", f"""
      SELECT
        transaction_hash,
        block_number AS tx_block_number,
        lower(from_address) AS from_address,
        lower(ifNull(to_address, '')) AS to_address,
        success,
        gas_used,
        substring(ifNull(input, ''), 1, 10) AS selector
      FROM default.canonical_execution_transaction FINAL
      WHERE meta_network_name = 'mainnet'
        AND block_number BETWEEN 25763888 AND 25771073
        AND transaction_hash IN ({literals})
    """))

roots = pd.concat(parts, ignore_index=True)
joined = xen.merge(roots, on=["transaction_hash", "tx_block_number"], how="left")
assert len(joined) == 5747 and joined.success.all()
```

Four verified batch-call shapes created **1,495,415 slots**, 98.1% of the XEN creations:

- CoinTool's XEN Batch Minter, selector `0xb1ae2ed1`, created **737,830**.
- The MCT XEN batch-mint NFT contract, `batchClaimRankWithGenerateNft`, created **514,355**.
- XEN Torrent's `bulkClaimRank`, selector `0xecef9201`, created **164,830**.
- An unlabeled batch contract calling `batchClaimRank`, selector `0xbb739814`, created **78,400**.

Those root transactions used **57,657,545,540 gas**. The whole day used **218,960,408,079**, so a cohort that was 0.31% of transactions consumed 26.33% of execution gas. The shape is exactly what the selectors say it is: large successful batches, usually adding hundreds of XEN slots at a time.

## The proposed meter

[EIP-8037](https://eips.ethereum.org/EIPS/eip-8037) is currently in Review. It assigns a storage set **64 state bytes** and charges `CPSB = 1,530` state gas per byte, so this one line item is plain integer arithmetic:

```text
1,524,235 slot creations × 64 bytes × 1,530 gas/byte
= 149,253,091,200 state gas
```

The proposal uses a separate state-gas counter and targets 50% utilization. The canonical blocks on August 16 had gas limits between **59,882,816 and 60,058,592**, with a 60 million median. Their limits summed to 431,134,545,308, making the day's 50% target **215,567,272,654 state gas**.

```sql
SELECT
  min(execution_payload_gas_limit) AS min_gas_limit,
  max(execution_payload_gas_limit) AS max_gas_limit,
  medianExact(execution_payload_gas_limit) AS median_gas_limit,
  count() AS blocks,
  sum(toUInt128(execution_payload_gas_limit)) AS summed_limit,
  summed_limit / 2 AS half_target
FROM mainnet.fct_block FINAL
WHERE status = 'canonical'
  AND slot_start_date_time >= toDateTime('2026-08-16 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-17 00:00:00');
```

That puts the XEN storage-set charge at **69.24% of the target**. It is a lower bound for these transactions under EIP-8037 because I only counted slots created inside the XEN token contract. The batch minters also created accounts and code, which the proposal meters separately.

This is not an activation forecast. [EIP-8372](https://eips.ethereum.org/EIPS/eip-8372) is still Draft and exists precisely because the state-byte price and raw state-gas limit may need a one-time calibration. Both proposals can change, and the block limit at activation may not look like August 16.

The ugly bit survives all of those caveats. A price calibrated against average state growth still has to deal with days when one old application owns almost three quarters of the net slot ledger. XEN may be gone by the time a state-gas market ships, but this workload shape will not politely disappear with it.
