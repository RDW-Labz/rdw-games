-- 0229 — referral credits ("Give $5, get $5")
--
-- Owner, 2026-07-05 (marketing batch #2). Whole-invoice credit, $5 each side.
--
--   bidders.referral_code          6-char shareable code, unique, auto-assigned
--   bidders.referred_by            who referred this bidder (set once at signup)
--   bidders.referral_credited_at   when the earn fired (send-once guard)
--   bidder_credits                 append-only ledger; balance = SUM(amount_cents)
--   invoices.credit_applied_cents  denormalized display of credit spent on it
--
-- Earn rule (enforced by the referral-credit-sweep cron, NOT here): the
-- referred bidder's first invoice must be PAID and PICKED UP before either
-- side is credited — you physically see the person, which kills fake-account
-- farming. Spend happens inside auto-charge before the Square call.
--
-- Idempotency shape mirrors the outbox: partial UNIQUE indexes make each
-- logical event insertable exactly once ('spend' once per invoice, one earn
-- per referred bidder, one welcome per bidder), so crash-retry code paths
-- can just insert and treat 23505 as "already done".
--
-- No BEGIN/COMMIT: ALTER TYPE ... ADD VALUE follows the mig-0167 pattern.
-- Every statement is idempotent.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'referral_credited';

-- ── bidders columns ──────────────────────────────────────────────────────────

ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS referred_by UUID;
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS referral_credited_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS bidders_referral_code_key
  ON public.bidders (referral_code)
  WHERE referral_code IS NOT NULL;

-- Code generator: 6 chars from an alphabet with no 0/O/1/I lookalikes.
-- SECURITY: not guessable-critical (codes are meant to be shared), just unique.
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code TEXT;
  v_i INT;
BEGIN
  LOOP
    v_code := '';
    FOR v_i IN 1..6 LOOP
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.bidders WHERE referral_code = v_code);
  END LOOP;
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.bidders_assign_referral_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.referral_code IS NULL THEN
    NEW.referral_code := public.generate_referral_code();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bidders_assign_referral_code ON public.bidders;
CREATE TRIGGER bidders_assign_referral_code
  BEFORE INSERT ON public.bidders
  FOR EACH ROW
  EXECUTE FUNCTION public.bidders_assign_referral_code();

-- Backfill existing bidders.
UPDATE public.bidders
SET referral_code = public.generate_referral_code()
WHERE referral_code IS NULL;

-- ── bidder_credits ledger ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bidder_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bidder_id UUID NOT NULL,
  -- Positive = credit granted, negative = credit consumed.
  amount_cents INT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'referral_earn',      -- referrer's $5 (related_bidder_id = the friend)
    'referral_welcome',   -- referred bidder's $5 (related_bidder_id = referrer)
    'spend',              -- applied to an invoice (invoice_id set, amount < 0)
    'spend_reversal',     -- charge failed after spend; puts the credit back
    'manual'              -- operator goodwill adjustments (either sign)
  )),
  related_bidder_id UUID,
  invoice_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bidder_credits_bidder_idx
  ON public.bidder_credits (bidder_id);

-- Exactly-once guarantees (insert + treat 23505 as already-done):
CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_spend_per_invoice
  ON public.bidder_credits (invoice_id) WHERE reason = 'spend';
CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_reversal_per_invoice
  ON public.bidder_credits (invoice_id) WHERE reason = 'spend_reversal';
CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_earn_per_referred
  ON public.bidder_credits (related_bidder_id) WHERE reason = 'referral_earn';
CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_welcome_per_bidder
  ON public.bidder_credits (bidder_id) WHERE reason = 'referral_welcome';

-- RLS: bidders read their own ledger; ALL writes are service-role only
-- (no INSERT/UPDATE/DELETE policies on purpose — money moves in trusted
-- server code, never from the client).
ALTER TABLE public.bidder_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bidder_credits_own_read ON public.bidder_credits;
CREATE POLICY bidder_credits_own_read
  ON public.bidder_credits FOR SELECT
  USING ((SELECT auth.uid()) = bidder_id);

-- ── invoices display column ──────────────────────────────────────────────────

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS credit_applied_cents INT NOT NULL DEFAULT 0;
