-- 0350 — a "self-raise" must never LOWER a bidder's maximum.
--
-- ── THE REPORT ──────────────────────────────────────────────────────────────
-- Owner, 2026-09-08: "Troy Pierce TEA5010715 Max Bid $46 Winning Bid ended at
-- $36 and he did not win customer was very upset."
--
-- He was right to be upset. On that lot (kimppierce@gmail.com, bidder #406) the
-- recorded maximum was $45.00 at 01:15:33, and $35.01 by the next proxy bid at
-- 09:48:37. The item sold at $36.00. With the maximum he actually set, his
-- proxy would have taken it at $37 and he would have won.
--
-- ── ROOT CAUSE ──────────────────────────────────────────────────────────────
-- place_bid's self-raise branch, added in 0216 and carried forward verbatim
-- through 0221 and 0263, wrote:
--
--     UPDATE bids SET max_amount_cents = p_max_amount_cents ...
--
-- with no check that the new value is larger. It is called a self-raise but it
-- will happily lower.
--
-- The bidder app feeds it lower numbers as a matter of course. The one-tap
-- Quick bid button (apps/bidder-app/app/lot/[id].tsx) renders, in its own
-- words, "in the NOT-outbid state (no bid yet or currently winning)", and calls
-- place_bid with nextMinimumBidCents() — the next increment above the CURRENT
-- PRICE, not above the bidder's own maximum. So a bidder who is winning with a
-- high proxy taps one button and their maximum is replaced by a small
-- increment. Because 0216 deliberately made this an UPDATE rather than an
-- INSERT (to keep the visible history clean), the bidder is never shown that it
-- happened and no audit row records it.
--
-- ── WHAT IT COST ────────────────────────────────────────────────────────────
-- Measured on prod: 65 lot/bidder pairs across 40 bidders had a maximum lowered
-- mid-auction. In 16 of them the bidder lost at a price AT OR BELOW the maximum
-- they had already set — 2026-07-08 through 2026-09-08. The worst was a
-- maximum of $45.00 replaced by $6.49 on a lot that sold for $20.55; nobody
-- lowers a bid from 45 to 6.49 on purpose.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- GREATEST, so a self-raise can only ever raise. Applied as a surgical patch:
-- the deployed definition is read back with pg_get_functiondef and exactly one
-- statement is rewritten, so no other part of the most safety-critical function
-- in the platform can drift while fixing it. It aborts loudly if the target
-- text is not found, and no-ops if the guard is already present.
--
-- This forbids lowering a maximum entirely. That is deliberate: there is no
-- path in either app today whose PURPOSE is to lower one, so every lowering
-- observed in two months of data was an accident. If deliberate reduction is
-- ever wanted it needs its own explicit control, not a side effect of the
-- quick-bid button.
--
-- The server-side fix matters more than the client one because it protects the
-- app versions already installed on bidders' phones — and OTA updates are not
-- currently reaching either platform.

BEGIN;

DO $do$
DECLARE
  v_src text;
  v_new text;
BEGIN
  v_src := pg_get_functiondef('public.place_bid(uuid,bigint)'::regprocedure);

  IF v_src ILIKE '%GREATEST(max_amount_cents, p_max_amount_cents)%' THEN
    RAISE NOTICE '0350: self-raise guard already present, nothing to do';
    RETURN;
  END IF;

  v_new := replace(v_src,
'    UPDATE bids
    SET max_amount_cents = p_max_amount_cents
    WHERE id = v_current_max_bid.id;',
'    UPDATE bids
    SET max_amount_cents = GREATEST(max_amount_cents, p_max_amount_cents)
    WHERE id = v_current_max_bid.id;');

  IF v_new = v_src THEN
    RAISE EXCEPTION '0350: place_bid self-raise patch target not found — refusing to guess';
  END IF;

  EXECUTE v_new;
END
$do$;

COMMIT;
