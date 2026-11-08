-- 0517 — additive cash/credit buckets on existing bidder_credits (#893 / scope 04)
--
-- Binding design: https://github.com/RDW-Labz/bingo-auctions/issues/892#issuecomment-6716835999
-- Confirm-first against master 7d1f609a. Do NOT land reserved 0497 as-is
-- (master already has 0509). Open PRs already claim 0486, 0500, 0503, 0510,
-- 0511, 0512, 0515, 0516; next free number above those is 0517.
--
-- Additive while BIDDER_CREDIT_BUCKETS_ENABLED is off (app env, fail-closed):
--   * this migration does not UPDATE/DELETE existing ledger rows
--   * no backfill of bucket onto historical rows (NULL = legacy credit)
--   * existing unique indexes unchanged (one spend / one reversal per invoice)
--   * legacy insert shape {bidder_id, amount_cents, reason, invoice_id} still works
--
-- The append-only trigger is live from apply-time on purpose. It is not
-- gated on BIDDER_CREDIT_BUCKETS_ENABLED (a Node env var this trigger
-- cannot read). Confirmed on master 7d1f609a: bidder_credits has no FKs,
-- so bidder / invoice / related_bidder_id deletes cannot CASCADE or SET
-- NULL into this ledger; delete_my_account tombstones bidders and does
-- not mention bidder_credits; application writers only INSERT. UPDATE or
-- DELETE of ledger rows raise 23001 immediately so history cannot vanish.
--
-- Two buckets on one invoice are ONE reason='spend' row with additive
-- spend_credit_cents + spend_cash_cents, not two spend rows.
-- Wallet loads are liabilities, not revenue. No expiry.
--
-- CHECK swap takes ACCESS EXCLUSIVE on bidder_credits. Apply only 05:00–07:00
-- CT with backup. Do not encode that clock in application code.
-- Rollback: scripts/prod-rig/0517_ROLLBACK_bidder_credits_buckets.sql
-- (prefer git revert + flag off; schema rollback needs the window).

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.bidder_credits
  ADD COLUMN IF NOT EXISTS bucket TEXT,
  ADD COLUMN IF NOT EXISTS spend_credit_cents INT,
  ADD COLUMN IF NOT EXISTS spend_cash_cents INT,
  ADD COLUMN IF NOT EXISTS owner_kind TEXT NOT NULL DEFAULT 'bidder',
  ADD COLUMN IF NOT EXISTS business_id UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS square_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS square_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS actor_user_id UUID,
  ADD COLUMN IF NOT EXISTS actor_staff_name TEXT,
  ADD COLUMN IF NOT EXISTS note TEXT;

COMMENT ON COLUMN public.bidder_credits.bucket IS
  '0517: cash|credit on grant/return/load/adjustment. NULL = legacy credit. Spend/reversal stay NULL and use split columns.';
COMMENT ON COLUMN public.bidder_credits.spend_credit_cents IS
  '0517: non-negative store-credit magnitude on spend/spend_reversal. NULL on legacy spend = entire abs(amount_cents) is credit.';
COMMENT ON COLUMN public.bidder_credits.spend_cash_cents IS
  '0517: non-negative wallet-cash magnitude on spend/spend_reversal. NULL on legacy spend = 0 cash.';
COMMENT ON COLUMN public.bidder_credits.square_payment_id IS
  '0517: wallet-load Square payment id (sandbox in tests). Liability, never revenue_source.';

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_bucket_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_bucket_check
  CHECK (bucket IS NULL OR bucket IN ('cash', 'credit'));

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_owner_kind_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_owner_kind_check
  CHECK (owner_kind IN ('bidder', 'business'));

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_spend_credit_cents_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_spend_credit_cents_check
  CHECK (spend_credit_cents IS NULL OR spend_credit_cents >= 0);

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_spend_cash_cents_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_spend_cash_cents_check
  CHECK (spend_cash_cents IS NULL OR spend_cash_cents >= 0);

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_spend_split_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_spend_split_check
  CHECK (
    (spend_credit_cents IS NULL AND spend_cash_cents IS NULL)
    OR (
      reason IN ('spend', 'spend_reversal')
      AND spend_credit_cents IS NOT NULL
      AND spend_cash_cents IS NOT NULL
      AND (
        (reason = 'spend' AND amount_cents = -(spend_credit_cents + spend_cash_cents))
        OR (reason = 'spend_reversal' AND amount_cents = spend_credit_cents + spend_cash_cents)
      )
    )
  );

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_business_credit_only_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_business_credit_only_check
  CHECK (
    owner_kind IS DISTINCT FROM 'business'
    OR (bucket = 'credit' AND (spend_cash_cents IS NULL OR spend_cash_cents = 0))
  );

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
    'refund_return',
    'wallet_load',
    'refund_as_credit',
    'credit_bonus',
    'cash_out',
    'adjustment',
    'boost_cancel_credit'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_idempotency_key
  ON public.bidder_credits (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_wallet_load_payment
  ON public.bidder_credits (square_payment_id)
  WHERE reason = 'wallet_load' AND square_payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.bidder_credits_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bidder_credits is append-only; corrections are new rows'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS bidder_credits_append_only ON public.bidder_credits;
CREATE TRIGGER bidder_credits_append_only
  BEFORE UPDATE OR DELETE ON public.bidder_credits
  FOR EACH ROW
  EXECUTE FUNCTION public.bidder_credits_forbid_mutation();

-- Balance = sum per owner per bucket. NULL bucket = legacy credit.
-- Spend/reversal use split columns when present; otherwise amount_cents
-- on the credit bucket. Business rows are excluded (no cross-owner reads).
CREATE OR REPLACE FUNCTION public.bidder_bucket_balance_cents(
  p_bidder_id uuid,
  p_bucket text
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(
    CASE
      WHEN bc.reason IN ('spend', 'spend_reversal') THEN
        CASE p_bucket
          WHEN 'credit' THEN
            CASE
              WHEN bc.spend_credit_cents IS NOT NULL THEN
                CASE WHEN bc.reason = 'spend' THEN -bc.spend_credit_cents ELSE bc.spend_credit_cents END
              WHEN COALESCE(bc.bucket, 'credit') = 'credit' THEN bc.amount_cents
              ELSE 0
            END
          WHEN 'cash' THEN
            CASE
              WHEN bc.spend_cash_cents IS NOT NULL THEN
                CASE WHEN bc.reason = 'spend' THEN -bc.spend_cash_cents ELSE bc.spend_cash_cents END
              WHEN COALESCE(bc.bucket, 'credit') = 'cash' THEN bc.amount_cents
              ELSE 0
            END
          ELSE 0
        END
      ELSE
        CASE WHEN COALESCE(bc.bucket, 'credit') = p_bucket THEN bc.amount_cents ELSE 0 END
    END
  ), 0)::integer
  FROM public.bidder_credits bc
  WHERE bc.bidder_id = p_bidder_id
    AND bc.owner_kind IS DISTINCT FROM 'business'
$$;

REVOKE ALL ON FUNCTION public.bidder_bucket_balance_cents(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bidder_bucket_balance_cents(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.bidder_bucket_balance_cents(uuid, text) TO authenticated, service_role;

COMMIT;
