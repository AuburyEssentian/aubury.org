---
slug: eip-8375-mev-burn-overlap
title: "EIP-8375's two one-third burns overlap by 36%"
description: "A 14-day backcast of EIP-8375 turns 735.1 ETH of standalone burns into 469.8 ETH after its priority-fee credit. In 90.8% of current MEV-Boost blocks, no builder top-up remains."
authors: aubury
tags: [ethereum, mev, mev-boost, epbs, eip-8375, data]
date: 2026-08-15
---

[EIP-8375](https://github.com/ethereum/EIPs/pull/12130) proposes two one-third burns. It burns one third of transaction priority fees in every payload, and it sets an external builder's auction target to one third of the signed gross bid. That sounds additive. It is not.

In a fixed signed-number backcast across 89,994 canonical MEV-Boost blocks, the two standalone amounts were **408.394 ETH** and **326.692 ETH**. Adding them gives 735.086 ETH, but the draft's actual credit rule burns **469.829 ETH**. The missing **265.257 ETH is overlap**, equal to 36.1% of the naive sum.

<!-- truncate -->

<figure>
  <a href="/img/eip-8375-mev-burn-overlap.png">
    <img src="/img/eip-8375-mev-burn-overlap.png" alt="Mechanical EIP-8375 backcast over 89,994 canonical MEV-Boost blocks from August 1 through 14 2026. Priority-fee burn is 408.4 ETH and the standalone auction target is 326.7 ETH, but 265.3 ETH overlaps, leaving 469.8 ETH of combined burn. In 81,679 blocks the priority-fee credit covers the full auction target." loading="eager" />
  </a>
  <figcaption>The fixed-bid backcast maps today's delivered MEV-Boost value to the draft's future <code>gross_value</code>. It is useful for reading the accounting rule, not predicting future bids.</figcaption>
</figure>

## The credit is the whole story

The draft calls transaction priority fees `T` and the signed external bid `G`. At its proposed one-third rate, execution burns `U = floor(T / 3)` in wei while consensus calculates an auction target `A = floor(G / 3)` in gwei. It then credits the whole-gwei part of `U` against `A` and asks the builder for only the remainder. Put bluntly, the mechanism is close to `max(one third of tips, one third of the bid)`, not their sum. Sub-gwei rounding makes the exact formula a little uglier:

```python
# Today's relay value is wei; the draft's gross_value is Gwei.
G = delivered_value_wei // 10**9
A = G // 3
U = priority_fee_value_wei // 3
R = min(A, U // 10**9)
D = A - R
combined_burn_wei = U + D * 10**9
```

`R` is the priority-fee burn credit and `D` is the builder top-up. Across the 14 complete UTC days from August 1 through August 14, `R` summed to **265.257 ETH**. The builder top-up was only **61.435 ETH**, on top of the 408.394 ETH already burned from tips.

The fixed block window ran from execution block **25,656,293 through 25,756,720**. Raw canonical execution data contained 100,428 unique block hashes in that range, while `fct_block_mev FINAL` supplied 89,994 positive-value canonical relay blocks. I pulled the relay side separately from the transaction side, then joined locally by block number.

```python
mev = clickhouse.query("clickhouse-refined", """
SELECT
  slot,
  slot_start_date_time,
  block_number,
  block_hash,
  toUInt256(value) AS delivered_value_wei,
  transaction_count
FROM mainnet.fct_block_mev FINAL
WHERE slot_start_date_time >= toDateTime('2026-08-01 00:00:00')
  AND slot_start_date_time <  toDateTime('2026-08-15 00:00:00')
  AND status = 'canonical'
  AND value IS NOT NULL
  AND value > 0
ORDER BY block_number
""")

tips = clickhouse.query("clickhouse-raw", """
SELECT
  t.block_number,
  uniqExact(t.transaction_hash) AS unique_transactions,
  sum(
    toUInt256(t.gas_used) * toUInt256(
      greatest(
        toInt256(0),
        toInt256(t.gas_price) - toInt256(b.block_base_fee_per_gas)
      )
    )
  ) AS priority_fee_value_wei
FROM default.canonical_execution_transaction AS t FINAL
GLOBAL INNER JOIN (
  SELECT
    block_number,
    argMax(toUInt64(base_fee_per_gas), updated_date_time)
      AS block_base_fee_per_gas
  FROM default.canonical_execution_block FINAL
  WHERE meta_network_name = 'mainnet'
    AND block_number BETWEEN 25656293 AND 25756720
    AND base_fee_per_gas IS NOT NULL
  GROUP BY block_number
) AS b USING (block_number)
WHERE t.meta_network_name = 'mainnet'
  AND t.block_number BETWEEN 25656293 AND 25756720
GROUP BY t.block_number
ORDER BY t.block_number
""")

blocks = mev.merge(tips, on="block_number", validate="one_to_one")
```

The grain checks stayed boring, which is exactly what I wanted. All 89,994 relay rows matched `mev_relay_proposer_payload_delivered FINAL` on exact block hash and value. Their stored transaction counts matched the raw transaction table in every block, and the full 14-day raw transaction count of **34,598,710** matched `fct_execution_transactions_daily FINAL` exactly.

I also rebuilt effective gas price from the fee fields instead of trusting `gas_price`. For type 2, 3 and 4 transactions, the check used `min(max_priority_fee_per_gas, max_fee_per_gas - base_fee_per_gas)`; types 0 and 1 used `gas_price - base_fee_per_gas`. It found **zero disagreements across all 34,598,710 transactions**, and both paths produced the same priority-fee wei total.

## Most blocks leave no builder bill

The credit completely covered the auction target in **81,679 of 89,994 blocks**, or **90.7605%**. Another 5,947 blocks covered at least half of it, 2,366 covered less than half, and two had no whole-gwei credit after rounding. This does not mean those blocks burn nothing from the builder's payload economics; the priority fees were already burned on the execution side. It means the consensus-layer builder top-up `D` fell to zero.

The remaining bill was badly concentrated. The top 899 blocks by delivered payment, roughly the top 1%, carried 24.1% of the observed payment value but **70.9% of the 61.435 ETH builder top-up**. Only 39.2% of those high-value blocks were fully covered, compared with 91.3% across the other 99%.

Ordinary blocks mostly pay the auction target out of the tip burn. The jackpots do not.

## The 90.8% is not a forecast

This backcast holds today's signed bid number fixed and relabels it as future `gross_value`. That is the cleanest way to inspect the draft's accounting, but future builders can change their bids. Current MEV-Boost `value` is a proposer payment, while EIP-8375 would make the proposer receive `G - floor(G / 3)` before any trusted-payment split.

I ran the obvious sensitivity check: gross up every future `G` just enough to preserve today's gwei-denominated proposer payment after the one-third target. Full coverage then falls from 90.8% to **45.8%**. The overlap itself does not go away. The two standalone burns become 898.432 ETH, the combined burn becomes 553.802 ETH, and **344.630 ETH, or 38.4%, is still credited rather than charged twice**.

That is the result I would keep. The exact share of zero-top-up blocks depends on how builders reprice. The large overlap comes from the draft's formula.

EIP-8375 is an open Draft PR, frozen here at commit [`b2bb0ef`](https://github.com/ethereum/EIPs/commit/b2bb0ef69e4b236703c30468d5773e896410a679). It is not scheduled or active, ePBS is not live on mainnet, and the proposed PTC bid-floor deadline, threshold and haircut are still `TBD`. Public, private and self-build behavior can all move after activation. A static backcast cannot settle those questions.

For now, the accounting is the interesting bit. This proposal does not stack a one-third tip burn on top of a one-third bid burn. It burns the overlap once, then leaves the rare expensive blocks with most of the builder bill.
