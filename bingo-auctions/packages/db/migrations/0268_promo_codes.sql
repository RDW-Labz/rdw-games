-- 0268 — promo codes ("enter a code, get $X off your next invoice")
--
-- Owner, 2026-07-15 (marketing batch: BidFTA-overlap re-engagement). Bidders
-- type a code in the app; the code's dollar value is minted as BinGo credit,
-- which the existing bidder_credits ledger (mig 0229) auto-applies to their
-- next auction invoice before the Square charge. Auction "checkout" is the
-- merchant-initiated auto-charge at close, so credit is the only redemption
-- shape that works — same bridge loyalty redemption uses (mig 0237).
--
-- Reusable by design: the operator can seed future campaign codes (e.g. a
-- win-back blast to lapsed bidders) by inserting another promo_codes row.
-- Eligibility + expiry + an overall cap live on the row, so no code change is
-- needed to run the next promo.
--
--   promo_codes                    one row per campaign code
--   promo_codes.eligibility        'all' | 'new_bidders_only'
--   promo_codes.max_redemptions    overall cap (NULL = unlimited)
--   promo_codes.expires_at         hard cutoff (NULL = never)
--   bidder_credits.promo_code_id   provenance of a 'promo' credit row
--
-- Exactly-once shape mirrors 0229/0237: a partial UNIQUE index on
-- bidder_credits(promo_code_id, bidder_id) WHERE reason='promo' makes the
-- credit itself the redemption record — one per (code, bidder) — so the
-- redeem endpoint just inserts and treats 23505 as "already redeemed".
-- No separate redemptions table needed.
--
-- Kept transactional (BEGIN/COMMIT) like 0237 — the CHECK swap is fine inside
-- one transaction. Every statement is idempotent.

BEGIN;

-- ── promo_codes ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored uppercase; the redeem endpoint upper-cases input before matching.
  code TEXT NOT NULL,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  eligibility TEXT NOT NULL DEFAULT 'all'
    CHECK (eligibility IN ('all', 'new_bidders_only')),
  -- Overall redemption cap across all bidders. NULL = unlimited.
  max_redemptions INT CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,          -- NULL = never expires
  note TEXT,                       -- internal label (which campaign)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_key
  ON public.promo_codes (code);

-- RLS: no bidder read (codes are validated server-side only); all access is
-- service-role. Clients never SELECT this table.
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

-- ── bidder_credits: 'promo' reason + provenance column ───────────────────────

ALTER TABLE public.bidder_credits
  ADD COLUMN IF NOT EXISTS promo_code_id UUID;

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
    'promo'
  ));

-- Exactly-once: one 'promo' credit per (code, bidder). The redeem endpoint
-- inserts and treats 23505 as "already redeemed", so retries converge.
CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_promo_per_bidder
  ON public.bidder_credits (promo_code_id, bidder_id)
  WHERE reason = 'promo';

-- ── seed: BINS5 (BidFTA-overlap campaign, Jul 2026) ──────────────────────────
-- $5 off, new bidders only, expires 30 days from apply. ON CONFLICT keeps
-- re-runs idempotent without resetting an already-tuned row.
INSERT INTO public.promo_codes (code, amount_cents, eligibility, expires_at, note)
VALUES ('BINS5', 500, 'new_bidders_only', now() + interval '30 days',
        'BidFTA-overlap re-engagement, Square Marketing blast Jul 2026')
ON CONFLICT (code) DO NOTHING;

COMMIT;
