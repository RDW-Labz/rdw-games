-- 0333 — seed charge_attempts with the decline codes that survived.
--
-- 0332 created the log going forward, but every historical decline lives in
-- invoices.last_auto_charge_error, and only the MOST RECENT one per invoice
-- survives — earlier attempts on the same invoice, and any invoice an operator
-- later settled offline, are gone for good. What is left is worth keeping:
-- without it the new "Card declines" panel is empty for every existing
-- customer, including the ones staff are asking about today.
--
-- Rows carry source='auto_charge' and the invoice's own attempt count. Only
-- genuine Square codes are seeded — the internal markers
-- ('offline_paid_by_operator', 'payments_disabled_test_mode', 'no_payment_method')
-- are operational state, not an issuer verdict, so they are skipped.

INSERT INTO public.charge_attempts (
  invoice_id, operator_id, bidder_id, attempted_at, source, outcome,
  amount_cents, square_code, attempt_number
)
SELECT
  i.id,
  i.operator_id,
  i.bidder_id,
  coalesce(i.last_auto_charge_at, i.updated_at, now()),
  'auto_charge',
  'declined',
  i.total_cents,
  i.last_auto_charge_error,
  i.auto_charge_attempt_count
FROM public.invoices i
WHERE i.last_auto_charge_error IS NOT NULL
  AND i.last_auto_charge_error NOT IN (
    'offline_paid_by_operator',
    'payments_disabled_test_mode',
    'payments_disabled_offline',
    'no_payment_method'
  )
  -- Idempotent: re-running must not duplicate the seed.
  AND NOT EXISTS (
    SELECT 1 FROM public.charge_attempts ca WHERE ca.invoice_id = i.id
  );
