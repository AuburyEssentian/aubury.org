---
slug: gloas-payment-settlement-sentinels
title: "Gloas's 2,281 dropped rows included 2,250 empty structs"
description: "Across 10 complete Platåberget days, the synthetic settlement table labelled 2,281 rows DROPPED. Only 31 were nonzero builder payments; one empty default appeared in every epoch."
authors: aubury
tags: [ethereum, gloas, glamsterdam, builders, data]
date: 2026-09-01
---

At first pass, Platåberget's new Gloas settlement table looks brutal. From August 21 through 30, **2,281 of 2,603 rows say `DROPPED`**, an apparent failure rate of 87.6%.

That number is garbage as a payment rate. **2,250 of the dropped rows are the same empty shape:** builder index zero, zero fee recipient, zero amount and zero weight. The observer emitted exactly one in every epoch. Filter those defaults out and the count flips: **31 of 353 nonzero pending-payment rows were dropped, or 8.8%**.

<!-- truncate -->

<img src="/img/gloas-payment-settlement-sentinels.png" alt="Dark chart correcting the Gloas pending-payment settlement table. The raw table has 2,603 rows and appears 87.6% dropped, but 2,250 dropped rows have amount zero. After requiring amount greater than zero, 322 of 353 pending-payment rows settled and 31 dropped. Settled value was 69.89 ETH versus 6.82 ETH dropped." loading="eager" />

## One empty row per epoch

I used ten complete UTC days and the raw `beacon_synthetic_builder_pending_payment_settlement` table. This is the query behind the chart:

```sql
SELECT
  outcome,
  count() AS raw_rows,
  countIf(amount = 0) AS empty_rows,
  countIf(amount > 0) AS payment_rows,
  sumIf(amount, amount > 0) AS payment_gwei,
  uniqExactIf(epoch, amount = 0) AS epochs_with_empty,
  countIf(amount > 0 AND weight >= quorum) AS payments_at_quorum,
  countIf(amount > 0 AND weight < quorum) AS payments_below_quorum
FROM `glamsterdam-devnet-8`.beacon_synthetic_builder_pending_payment_settlement FINAL
WHERE epoch_start_date_time >= toDateTime('2026-08-21 00:00:00')
  AND epoch_start_date_time <  toDateTime('2026-08-31 00:00:00')
GROUP BY outcome
ORDER BY outcome;
```

The `DROPPED` bucket contained 2,281 rows. Of those, 2,250 had `amount = 0`; the remaining 31 represented 6.824281790 ETH. The `SETTLED` bucket contained 322 rows, all nonzero, worth 69.893316439 ETH. By value, the nonzero split was 8.9% dropped and 91.1% settled.

The zero row was not merely common. It appeared exactly once in each of the window's **2,250 epochs**, always as `(builder_index=0, fee_recipient=0x00...00, amount=0, weight=0)`. That regularity is the tell.

## An empty struct is not a payment

The [Gloas state transition at commit `0c68a7e`](https://github.com/ethereum/consensus-specs/blob/0c68a7e9469bb84ed6be393be1a29394f4e8547b/specs/gloas/beacon-chain.md#new-process_execution_payload_bid) only creates a pending payment when the bid value is positive:

```python
# Record the pending payment if there is some payment
if amount > 0:
    pending_payment = BuilderPendingPayment(...)
    state.builder_pending_payments[...] = pending_payment
```

A default `BuilderPendingPayment()` has zeroed fields. The epoch processor scans the previous epoch's fixed payment window and then replaces it with a fresh set of defaults. The synthetic event surface is exposing one of those defaults as `DROPPED`; it is not evidence that a builder promised zero ETH and failed to pay it.

The threshold logic itself behaved cleanly after the filter. Every one of the 322 settled rows had `weight >= quorum`. Every one of the 31 dropped rows was below quorum. Nothing sat on the wrong side of the rule.

## The bids are real; the raw denominator is not

I cross-checked the 353 nonzero rows against raw signed payload bids. The settlement event does not carry the source slot, so I fetched the bounded bid set separately, normalized the fee-recipient address casing, and matched on builder, recipient and amount in the previous epoch:

```python
settlements = clickhouse.query("clickhouse-raw", """
  SELECT epoch AS settlement_epoch, builder_index,
         lower(fee_recipient) AS fee_recipient,
         amount, weight, quorum, outcome
  FROM `glamsterdam-devnet-8`.beacon_synthetic_builder_pending_payment_settlement FINAL
  WHERE epoch_start_date_time >= toDateTime('2026-08-21 00:00:00')
    AND epoch_start_date_time <  toDateTime('2026-08-31 00:00:00')
    AND amount > 0
""")

bids = clickhouse.query("clickhouse-raw", """
  SELECT epoch AS bid_epoch, slot, block_root, builder_index,
         lower(fee_recipient) AS fee_recipient, value
  FROM `glamsterdam-devnet-8`.canonical_beacon_block_execution_payload_bid FINAL
  WHERE slot_start_date_time >= toDateTime('2026-08-20 00:00:00')
    AND slot_start_date_time <  toDateTime('2026-08-31 00:00:00')
    AND builder_index IS NOT NULL
    AND value > 0
""")

matched = settlements.merge(bids, on=["builder_index", "fee_recipient"])
matched = matched[
    (matched.amount == matched.value)
    & (matched.bid_epoch == matched.settlement_epoch - 1)
]
```

All **353 nonzero settlement rows matched exactly one prior-epoch bid**. That independent path recovered the same builder and amount instead of trusting the settlement label alone. Of the matched source blocks, 327 were canonical in the refined block model and 26 were later classified as orphaned, which is another reason not to turn this one observer's rows into chain-wide economic accounting.

There is a second denominator trap here. Gloas settles a builder payment as soon as the full parent payload is processed. The epoch-boundary function only handles payments still sitting in the previous epoch's pending window, using ordinary attestation weight to decide whether they survive. This table is therefore a narrow cleanup surface, not a feed of every builder payment.

The corrected 8.8% is useful, but its label needs all the ugly words: **the dropped share of nonzero epoch-boundary pending-payment rows seen by one Tysm observer on Platåberget**. It is not a builder failure rate for the devnet, much less for Ethereum.

The `amount > 0` predicate is not optional cleanup. It is the line between protocol objects and empty state slots.
