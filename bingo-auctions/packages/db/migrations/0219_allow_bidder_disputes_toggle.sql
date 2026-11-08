-- 0219 — operator toggle: bidder-facing "Report a problem" (disputes)
--
-- Tester round-6 (2026-07-03): the receipt's "Report a problem" entry invites
-- post-pickup photo disputes. It was gated on refund_window_post_pickup_hours
-- > 0 — but that column now does double duty: BinGo runs a 1-hour STAFF
-- counter-grace window (round-5 ops recommendation) while the customer-facing
-- policy is "all sales final once you leave." One column can't express
-- "staff may refund for an hour, bidders shouldn't be invited to dispute."
--
-- allow_bidder_disputes separates the two: it gates ONLY the bidder-app
-- dispute entry points. Staff refund tooling (refund window + manager
-- override + audit) is untouched. Default TRUE preserves behavior for any
-- operator that wants post-pickup disputes; BinGo is set FALSE.

BEGIN;

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS allow_bidder_disputes BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.operator_policies.allow_bidder_disputes IS
  '0219: gates the bidder-app "Report a problem" (post-pickup dispute) entry '
  'points ONLY. FALSE = zero-refund storefronts hide the invitation; staff '
  'refund tooling and windows are unaffected.';

UPDATE public.operator_policies
SET allow_bidder_disputes = FALSE
WHERE operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d';

COMMIT;
