-- 0270 — correct refund accounting (captured-amount guard, credit return, reporting net)
--
-- Owner, 2026-07-16. Read-only money audit found (verified against prod code):
--   BLOCKER: refund routes guard/compute against invoices.total_cents, but the
--     card was only charged `total_cents - credit_applied_cents` (auto-charge
--     applies bidder_credits before the Square charge). Refunding up to
--     total_cents on a credit-discounted invoice either over-refunds real cash
--     or (today) is only stopped by Square's own cumulative cap. And a legit
--     full refund of a credit-discounted invoice was rejected by Square.
--   HIGH: consumed bidder_credits was never returned on refund — the bidder
--     permanently lost the credit they'd redeemed.
--   BLOCKER (reporting): invoices carry no refunded amount, and partial refunds
--     flip status to 'partially_refunded' which the P&L filter (status='paid')
--     excludes entirely — so a refunded invoice's whole revenue + TAX vanish
--     from reports, making the remittable-tax figure wrong.
--
-- This migration adds the columns those fixes need. The route + reporting code
-- changes ship alongside (same PR). No data backfill: existing refunds pre-date
-- accumulator tracking; the columns default 0 and start accruing forward.
--
--   invoices.refunded_cash_cents    cumulative CASH returned to the card via
--                                   Square RefundPayment. The captured-amount
--                                   guard is `<= total_cents - credit_applied
--                                   _cents - refunded_cash_cents`.
--   invoices.refunded_credit_cents  cumulative bidder_credits RETURNED on refund
--                                   (the portion of a refund that came back as
--                                   store credit rather than cash).
--   invoices.refunded_tax_cents     cumulative FACE tax refunded (for reporting
--                                   net-of-refund tax remittance). Face, not
--                                   cash, because the sale (and its tax) is
--                                   reversed regardless of cash-vs-credit split.
--   Face value refunded (revenue reversed) = refunded_cash + refunded_credit.
--
--   bidder_credits reason 'refund_return' — the positive ledger row minted when
--   a refund returns previously-consumed credit to the bidder.
--
-- Transactional; all statements idempotent.

BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS refunded_cash_cents   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_credit_cents INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_tax_cents    INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.invoices.refunded_cash_cents IS
  '0270: cumulative cash refunded to the card via Square. Captured-amount guard: refunds cap at total_cents - credit_applied_cents - refunded_cash_cents.';
COMMENT ON COLUMN public.invoices.refunded_credit_cents IS
  '0270: cumulative store credit returned to the bidder on refund (the non-cash portion). Face refunded = refunded_cash_cents + refunded_credit_cents.';
COMMENT ON COLUMN public.invoices.refunded_tax_cents IS
  '0270: cumulative face sales tax refunded — subtract from tax_cents for net-of-refund tax remittance reporting.';

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_reason_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_reason_check CHECK (reason IN (
    'referral_earn',
    'referral_welcome',
    'spend',
    'spend_reversal',
    'manual',
    'loyalty_redeem',
    'promo',
    'refund_return'
  ));

COMMIT;
