---
slug: eip-8347-dormant-preimage-file
title: "Two-thirds of EIP-8347's preimage file is dormant storage"
description: "A current mainnet backcast puts draft EIP-8347's fixed-width preimage file at 62.25 GB. Roughly 40.7 GB maps to storage keys untouched for a year."
authors: aubury
tags: [ethereum, state, storage, eip-8347, pbt, xatu]
date: 2026-08-21
---

[EIP-8347](https://eips.ethereum.org/EIPS/eip-8347) changed one file format on August 20. The new format is brutally easy to size: 24 bytes per account, then 32 bytes per live storage slot. Point that arithmetic at mainnet on August 19 and the file comes out at **62.25 GB**.

Roughly **40.7 GB** of it maps to slot keys that had not been read or written in twelve months.

<!-- truncate -->

<img src="/img/eip-8347-dormant-preimage-file.png" alt="Dark stacked bar chart backcasting draft EIP-8347's fixed-width mainnet preimage file to 62.25 GB at the end of August 19, 2026. Account records use 9.9 GB, storage keys touched within twelve months use about 11.7 GB, and storage keys untouched for more than twelve months use about 40.7 GB, or 65.3% of the whole file." loading="eager" />

## The file

The MPT does not store the plain keys behind its paths. It stores `keccak256(address)` and `keccak256(slotKey)`, and Keccak does not run backward. EIP-8347 therefore needs a separate preimage artifact so a converter can match every hashed MPT leaf to the address or storage key that created it.

[PR #12215](https://github.com/ethereum/EIPs/pull/12215), merged on August 20, replaced the draft's RLP list with this fixed-width record:

```text
address[20] | slotCount[4, big-endian] | slotKey[32] * slotCount
```

It also changed the order from plain keys to their Keccak hashes. That makes conversion a sequential merge against MPT traversal instead of a giant random-access lookup. Erigon's merged [preimage exporter](https://github.com/erigontech/erigon/pull/22645) uses the same format and checks the same size identity in code: `accounts × 24 + slots × 32`.

I froze the last complete UTC day, resolved its canonical end block, and ran the state count through both the daily and by-block models. This is the executed path, trimmed to the fields used here:

```python
from ethpandaops import clickhouse

state = clickhouse.query("clickhouse-refined", """
SELECT
  day_start_date,
  accounts,
  storages,
  toUInt128(accounts) * 24 AS account_record_bytes,
  toUInt128(storages) * 32 AS slot_key_bytes,
  account_record_bytes + slot_key_bytes AS preimage_bytes
FROM mainnet.fct_execution_state_size_daily FINAL
WHERE day_start_date = toDate('2026-08-19')
""")

by_block = clickhouse.query("clickhouse-refined", """
SELECT
  block_number,
  accounts,
  storages,
  toUInt128(accounts) * 24 + toUInt128(storages) * 32 AS preimage_bytes
FROM mainnet.int_execution_state_size_by_block FINAL
WHERE block_number = 25792601
""")

assert state.accounts.iloc[0] == by_block.accounts.iloc[0]
assert state.storages.iloc[0] == by_block.storages.iloc[0]
assert state.preimage_bytes.iloc[0] == by_block.preimage_bytes.iloc[0]
```

Both paths returned **411,948,098 accounts** and **1,636,436,505 live storage slots** at canonical block **25,792,601**. The fixed-width arithmetic is not an estimate:

```text
411,948,098 × 24 =  9,886,754,352 bytes
1,636,436,505 × 32 = 52,365,968,160 bytes
                      ------------------
                      62,252,722,512 bytes
```

That is **62.25 decimal GB**, or **57.98 GiB**. It is the logical, uncompressed preimage file, not the PBT snapshot itself, not a compressed download, and not measured client disk use. The same backcast was 61.36 GB on July 21, so the key list grew by another **895.8 MB** in 29 days.

## The part BALs cannot hand back

EIP-8347 plans to use Block-Level Access Lists to recover plain keys touched after BAL activation. The nasty part is everything already in state that nobody touches. Those keys still need a client preimage store or a replay from history because the anchor MPT only has their hashes.

Xatu's expiry models let me put a size on that cold set. Their definition of a touch includes both storage reads and writes, and reactivations are added back into the live cohort. I pulled the no-expiry baseline and the twelve-month counterfactual separately rather than hiding the two grains inside one distributed join:

```python
base = clickhouse.query("clickhouse-refined", """
SELECT day_start_date, active_slots
FROM mainnet.fct_storage_slot_state_by_block_daily FINAL
WHERE day_start_date = toDate('2026-08-19')
""")

within_12m = clickhouse.query("clickhouse-refined", """
SELECT day_start_date, active_slots
FROM mainnet.fct_storage_slot_state_with_expiry_by_block_daily FINAL
WHERE expiry_policy = '12m'
  AND day_start_date = toDate('2026-08-19')
""")
```

The expiry path had **1,641,138,031** live slots before expiry and **366,650,671** after removing anything untouched for twelve months. The difference is **1,274,487,360 slots**, or **77.6588%** of that model's live-slot baseline. At 32 bytes per key, the direct expiry-model count is **40.78 GB**.

There is a small model boundary to keep honest. The expiry baseline is 4,701,526 slots, or **0.286%**, above the state-size model used for the exact file total. The chart applies the expiry path's 77.6588% cold share to the exact state-size slot bytes, producing **40.67 GB**. Either route rounds to **40.7 GB**, and that is **65.3% of the full fixed-width file** once the 9.89 GB account-record limb is included.

This is a one-year thought experiment, not a claim that BALs have already accumulated a year of mainnet history. It says that even if they had, roughly four out of five current storage keys would still be missing from that recent touch stream. Reads help, but most of the state is colder than the recovery window.

EIP-8347 is still Draft. Its anchor block and activation fork are both TBD, the PBT snapshot is a separate 100+ GB artifact, and transport compression will change bytes on the wire. Nodes that self-convert may generate the preimages locally instead of downloading them.

The format change solved the random-read problem. It did not make the keys disappear. For this draft, cold Ethereum state is still most of the file.
