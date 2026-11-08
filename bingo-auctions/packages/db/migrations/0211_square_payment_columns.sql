-- 0211 — Square payment-processor columns (BinGo cutover from Stripe).
--
-- Additive only. The stripe_* columns are kept DORMANT until a post-cutover
-- cleanup migration drops them once Square is proven in production. Card data
-- itself is NEVER stored — we keep only Square references (customer id +
-- card-on-file id) plus non-sensitive display crumbs (brand/last4/exp).

-- bidders: Square customer + card-on-file display metadata.
-- The existing `default_payment_method_id` column is REUSED to hold the Square
-- card-on-file id (ccof:...) post-cutover; it held the Stripe pm_ id before.
ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS square_customer_id text,
  ADD COLUMN IF NOT EXISTS card_brand text,
  ADD COLUMN IF NOT EXISTS card_last4 text,
  ADD COLUMN IF NOT EXISTS card_exp_month smallint,
  ADD COLUMN IF NOT EXISTS card_exp_year smallint;

COMMENT ON COLUMN bidders.square_customer_id IS
  'Square Customers API customer id (parallel to stripe_customer_id).';
COMMENT ON COLUMN bidders.default_payment_method_id IS
  'Post-cutover: Square card-on-file id (ccof:...). Pre-cutover: Stripe pm_ id.';

-- invoices: Square payment + refund references (parallel to stripe_*).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS square_payment_id text,
  ADD COLUMN IF NOT EXISTS square_refund_id text;

-- NOTE: no payment_processor switch column. BinGo is all-Square — Square is the
-- only charge path. The existing platform_settings.payments_disabled flag stays
-- as the single offline↔live toggle (flip to false at cutover → Square charges).
