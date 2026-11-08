-- 0237 — loyalty redemption → BinGo credit (Phase 2 of the Square bridge)
--
-- Owner, 2026-07-06: bidders redeem Square Loyalty points from their
-- profile; the reward's dollar value is minted as BinGo credit, which the
-- existing ledger auto-applies to their next invoice (auction "checkout"
-- is the auto-charge — credit is the only redemption shape that works).
--
--   reason 'loyalty_redeem'    the minted credit row
--   loyalty_reward_id          the Square reward consumed for it; UNIQUE
--                              (partial) = exactly-once per reward, so a
--                              retried redemption can never double-mint.
--
-- No BEGIN around the constraint swap is fine inside one transaction —
-- kept transactional like 0229.

BEGIN;

ALTER TABLE public.bidder_credits
  ADD COLUMN IF NOT EXISTS loyalty_reward_id TEXT;

ALTER TABLE public.bidder_credits
  DROP CONSTRAINT IF EXISTS bidder_credits_reason_check;
ALTER TABLE public.bidder_credits
  ADD CONSTRAINT bidder_credits_reason_check CHECK (reason IN (
    'referral_earn',
    'referral_welcome',
    'spend',
    'spend_reversal',
    'manual',
    'loyalty_redeem'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS bidder_credits_one_per_loyalty_reward
  ON public.bidder_credits (loyalty_reward_id)
  WHERE reason = 'loyalty_redeem';

COMMIT;
