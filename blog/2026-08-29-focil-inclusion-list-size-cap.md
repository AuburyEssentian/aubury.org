---
slug: focil-inclusion-list-size-cap
title: FOCIL's 8,348-byte cap forgot four bytes per transaction
description: The Heze spec bounded raw transaction bytes but forgot SSZ's per-transaction offsets. Lodestar refused 209 of 211 local inclusion-list publishes on a FOCIL devnet.
authors: aubury
tags: [ethereum, eip-7805, focil, hegota, ssz, data]
date: 2026-08-29
---

FOCIL's inclusion-list gossip limit looked precise: 8,348 bytes. It was precise for one 8,192-byte transaction, but real inclusion lists carry dozens of transactions, and SSZ adds a four-byte offset for every one. On `focil-devnet-0`, that mismatch made Lodestar refuse **209 of 211 local publish attempts**.

<!-- truncate -->

<img src="/img/focil-inclusion-list-size-cap.png" alt="Chart showing FOCIL's old 8,348-byte inclusion-list gossip cap, an 8,586-byte devnet list that Lodestar refused, and the proposed 41,112-byte worst-case bound. Lodestar refused 209 of 211 local publish attempts on focil-devnet-0." loading="eager" />

## The number fit the fixture

The old Heze networking spec capped an uncompressed `SignedInclusionList` at 8,348 bytes. Its maximum-size test built one transaction containing all 8,192 allowed raw transaction bytes. Add 156 bytes of container and offset overhead and the fixture lands exactly on the cap.

That only works for one transaction. A `Transactions` list is variable-size SSZ, so its encoding starts with one four-byte offset per item. The full signed message is therefore:

`152 fixed bytes + 4 × transaction count + raw transaction bytes`

The consensus rule checked only the final term. It allowed up to 8,192 raw transaction bytes without charging the offset table against the gossip cap.

I reproduced the boundary with Panda's ClickHouse path. This is the exact query behind the arithmetic in the chart:

```python
from ethpandaops import clickhouse

rows = clickhouse.query("clickhouse-refined", """
WITH 8192 AS byte_budget, 8348 AS old_cap
SELECT
  number + 1 AS tx_count,
  byte_budget AS raw_tx_bytes,
  152 + 4 * tx_count + raw_tx_bytes AS signed_ssz_bytes,
  signed_ssz_bytes > old_cap AS rejected_by_old_cap,
  signed_ssz_bytes - old_cap AS overflow_bytes
FROM numbers(byte_budget)
WHERE tx_count IN (1, 2, 59, 67, 8192)
ORDER BY tx_count
""")
```

One maxed-out transaction is 8,348 bytes and passes. Split the same raw bytes across two transactions and the message becomes 8,352 bytes, already four bytes too large. At 59 and 67 transactions, the full-budget shapes are 8,580 and 8,612 bytes.

The failure was not theoretical. [consensus-specs issue #5575](https://github.com/ethereum/consensus-specs/issues/5575) reports Teku lists with 59–67 transactions and 7,352–8,189 raw transaction bytes on the small FOCIL devnet. Lodestar logged `ssz_snappy encoded data length 8586 > 8348` and refused 209 of 211 attempts, a **99.05% local failure rate**. [Lodestar PR #9935](https://github.com/ChainSafe/lodestar/pull/9935) records the same count while fixing a separate `dependent_root` mismatch.

## Snappy never got a chance

The error name is a little misleading. Lodestar's outbound transform checked the uncompressed SSZ `data.length` against the topic maximum before running Snappy compression. Its inbound path read the advertised uncompressed length from the Snappy frame and applied the same maximum before decoding the object.

So this was not a bandwidth limit that compression might squeeze under. It was a pre-decode compatibility split: a client enforcing 8,348 bytes could refuse a spec-valid multi-transaction list that another client produced.

## The repair is deliberately much larger

Open [consensus-specs PR #5576](https://github.com/ethereum/consensus-specs/pull/5576) raises the cap to **41,112 bytes** and adds a rule that every transaction must be non-empty. The new worst case is 8,192 one-byte transactions. Each consumes one raw byte plus its four-byte SSZ offset, giving `152 + 5 × 8,192 = 41,112`.

That **40 KiB** number is protocol headroom, not a claim that honest inclusion lists are suddenly five times larger. The observed lists were around 8.6 KiB. The wider bound avoids baking today's minimum execution-transaction encoding into the consensus layer, while [execution-apis PR #870](https://github.com/ethereum/execution-apis/pull/870) aligns the Engine API on the same raw-byte ruler.

EIP-7805 is still Draft, although it is Scheduled for Inclusion in Hegotá. The Heze spec is explicitly work in progress, PR #5576 is still open, and no Mainnet activation date exists. This is exactly what a devnet is supposed to catch.

The old number was not random. It was a test fixture mistaken for a bound.
