// Per-lot refund math for the operator refund dialog.
//
// WHY (2026-07-08 recap): refunding a single missing/not-as-described lot on a
// multi-lot invoice, managers had to hand-calculate the amount (hammer + 15%
// buyer's premium + proportional sales tax). The field-mobile RefundItemsSheet
// already auto-computes this; operator-web did not. This is the shared helper
// the mobile sheet's comment already claimed existed.
//
// A lot's full refundable amount = its hammer (winning bid) plus its
// hammer-proportional share of the invoice's buyer's premium and sales tax.
// This split is exact because premium is a flat % of hammer and tax is a flat
// rate on (subtotal + premium) for the WHOLE invoice, and tax-exemption is
// per-bidder/whole-invoice (mig 0233) — never per-lot. Shipping is omitted:
// BinGo is pickup-based and a single-lot refund shouldn't return shipping.

export type InvoiceMoney = {
  subtotal_cents: number | null;
  buyer_premium_cents: number | null;
  tax_cents: number | null;
};

export function computeLotFullRefundableCents(
  inv: InvoiceMoney,
  winningBidCents: number,
): number {
  if (winningBidCents <= 0) return 0;
  const subtotal = inv.subtotal_cents ?? 0;
  // No subtotal to prorate against → refund just the hammer (defensive).
  if (subtotal <= 0) return winningBidCents;
  const ratio = winningBidCents / subtotal;
  return (
    winningBidCents +
    Math.round((inv.buyer_premium_cents ?? 0) * ratio) +
    Math.round((inv.tax_cents ?? 0) * ratio)
  );
}

// ── Refund cash-vs-credit split (mig 0270) ──────────────────────────────────
//
// The card was only charged `captured = total_cents - credit_applied_cents`
// (auto-charge applies bidder_credits before the Square charge). So a refund
// of FACE value R must never return more than `captured` in cash — the excess
// is store credit the bidder is owed back. "Cash-first": draw cash up to the
// remaining captured amount, return the rest as credit. This guarantees
// cumulative cash refunded never exceeds what was actually captured (no
// real-money over-refund) while still making the bidder whole for the full
// face value R. For the common no-credit invoice (credit_applied = 0) this
// returns cash = R, credit = 0 — identical to the prior behavior.

export type RefundSplit = {
  /** Cash to return to the card via Square RefundPayment. */
  cashCents: number;
  /** Store credit to mint back to the bidder (bidder_credits refund_return). */
  creditCents: number;
  /** Face sales-tax portion of this refund (for reporting net-of-refund tax). */
  taxCents: number;
};

export function computeRefundSplit(args: {
  totalCents: number;
  creditAppliedCents: number;
  /** Cash already refunded on this invoice (invoices.refunded_cash_cents). */
  refundedCashCents: number;
  /** Invoice face sales tax (invoices.tax_cents). */
  taxCents: number;
  /** Requested face refund amount R (hammer + premium + tax of refunded lots). */
  requestedFaceCents: number;
}): RefundSplit {
  const total = Math.max(0, Math.round(args.totalCents));
  const creditApplied = Math.max(0, Math.round(args.creditAppliedCents));
  const priorCash = Math.max(0, Math.round(args.refundedCashCents));
  const R = Math.max(0, Math.round(args.requestedFaceCents));

  const captured = Math.max(0, total - creditApplied);
  const remainingCash = Math.max(0, captured - priorCash);
  const cashCents = Math.min(R, remainingCash);
  const creditCents = Math.max(0, R - cashCents);
  const taxCents = total > 0 ? Math.round((R * (args.taxCents ?? 0)) / total) : 0;
  return { cashCents, creditCents, taxCents };
}
