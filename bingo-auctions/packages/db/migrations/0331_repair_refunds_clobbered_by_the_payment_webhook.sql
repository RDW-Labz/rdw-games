-- 0331 — repair invoices whose refund state was overwritten by payment.updated.
--
-- Square re-fires payment.updated when a refund is applied to a payment: the
-- payment's refunded_money changes, its status stays COMPLETED. The webhook's
-- "make sure a COMPLETED payment is marked paid" backstop only skipped rows
-- already reading 'paid', so it happily re-stamped an invoice the refund route
-- had just set to refunded/partially_refunded — overwriting paid_at with the
-- refund's timestamp, and (when it landed after the refund.updated event)
-- putting the invoice back to 'paid' outright.
--
-- Damage as of 2026-08-25:
--   * paid_at clobbered on 318 invoices, back to 2026-07-03
--   * 1 fully-refunded BinGo invoice (a5c6981d…, pdunnegan@gmail.com, $5.04)
--     left reading 'paid' — the money was returned at Square, the dashboard
--     said otherwise
--
-- The webhook guard ships alongside this migration; this file repairs history.

-- 1. Status: a fully cash/credit-refunded invoice must not read 'paid'.
--    Scoped to rows that carry proof of a refund (a Square refund id or
--    refunded money) covering the whole face value.
update invoices
   set status = 'refunded'
 where status = 'paid'
   and (square_refund_id is not null or coalesce(refunded_cash_cents, 0) > 0)
   and coalesce(refunded_cash_cents, 0) + coalesce(refunded_credit_cents, 0)
       >= total_cents;

update invoices
   set status = 'partially_refunded'
 where status = 'paid'
   and (square_refund_id is not null or coalesce(refunded_cash_cents, 0) > 0)
   and coalesce(refunded_cash_cents, 0) + coalesce(refunded_credit_cents, 0)
       < total_cents;

-- 2. paid_at: recover the real payment time from the receipt notification the
--    payment enqueued (idempotency_key = 'receipt:{invoice_id}'), for any
--    refunded invoice whose paid_at now sits at/after its first lot refund.
with first_refund as (
  select invoice_id, min(refunded_at) as at
    from invoice_lots
   where refunded_at is not null
   group by invoice_id
),
receipt as (
  select substring(idempotency_key from 9)::uuid as invoice_id,
         min(created_at) as at
    from notifications_outbox
   where idempotency_key like 'receipt:%'
     and kind = 'payment_succeeded'
   group by 1
)
update invoices i
   set paid_at = receipt.at
  from first_refund, receipt
 where first_refund.invoice_id = i.id
   and receipt.invoice_id = i.id
   and i.paid_at > first_refund.at
   and receipt.at < first_refund.at;

-- 3. refunded_at: no code path ever set it, so all 858 refunded invoices show a
--    blank refund date on the operator invoice page. Backfill from the per-lot
--    stamp, which the refund routes have always written.
update invoices i
   set refunded_at = fr.at
  from (
    select invoice_id, min(refunded_at) as at
      from invoice_lots
     where refunded_at is not null
     group by invoice_id
  ) fr
 where fr.invoice_id = i.id
   and i.refunded_at is null
   and i.status in ('refunded', 'partially_refunded');
