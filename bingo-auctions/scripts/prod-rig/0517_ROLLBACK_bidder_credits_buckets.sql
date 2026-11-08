-- Rollback for 0517 (additive bidder_credits buckets). Do NOT apply from this PR.
-- Needs backup + 05:00–07:00 CT + owner approval. DROP COLUMN takes ACCESS EXCLUSIVE.
-- Prefer flag-off + `git revert` of the implementing commit; leave schema inert.
--
-- Refuses when any new-reason, cash-bucket, business-owned, or split-spend
-- row exists. Dropping bucket / spend_* / owner_kind / business_id would
-- make legacy SUM(amount_cents) readers treat wallet cash or business
-- grants as bidder store credit. A reason-only guard is not enough:
-- cash-bucket manual grants, business-owned manual grants, and split
-- spends keep legacy reason values ('manual' / 'spend').

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bidder_credits
     WHERE reason NOT IN (
       'referral_earn', 'referral_welcome', 'spend', 'spend_reversal',
       'manual', 'loyalty_redeem', 'promo', 'refund_return'
     )
        OR bucket IS NOT NULL
        OR spend_credit_cents IS NOT NULL
        OR spend_cash_cents IS NOT NULL
        OR owner_kind IS DISTINCT FROM 'bidder'
        OR business_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0517 rollback refused: cash-bucket, business-owned, split-spend, or new-reason rows exist; dropping those columns would make legacy readers treat wallet or business funds as bidder credit; keep schema and leave the flag off';
  END IF;
END $$;

DROP TRIGGER IF EXISTS bidder_credits_append_only ON public.bidder_credits;
DROP FUNCTION IF EXISTS public.bidder_credits_forbid_mutation();
DROP FUNCTION IF EXISTS public.bidder_bucket_balance_cents(uuid, text);

DROP INDEX IF EXISTS public.bidder_credits_one_idempotency_key;
DROP INDEX IF EXISTS public.bidder_credits_one_wallet_load_payment;

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_bucket_check,
  DROP CONSTRAINT IF EXISTS bidder_credits_owner_kind_check,
  DROP CONSTRAINT IF EXISTS bidder_credits_spend_credit_cents_check,
  DROP CONSTRAINT IF EXISTS bidder_credits_spend_cash_cents_check,
  DROP CONSTRAINT IF EXISTS bidder_credits_spend_split_check,
  DROP CONSTRAINT IF EXISTS bidder_credits_business_credit_only_check,
  DROP CONSTRAINT IF EXISTS bidder_credits_reason_check,
  DROP COLUMN IF EXISTS bucket,
  DROP COLUMN IF EXISTS spend_credit_cents,
  DROP COLUMN IF EXISTS spend_cash_cents,
  DROP COLUMN IF EXISTS owner_kind,
  DROP COLUMN IF EXISTS business_id,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS square_payment_id,
  DROP COLUMN IF EXISTS square_refund_id,
  DROP COLUMN IF EXISTS actor_user_id,
  DROP COLUMN IF EXISTS actor_staff_name,
  DROP COLUMN IF EXISTS note;

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
