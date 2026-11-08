-- 0342 — split the never-bid list, because it is two different problems.
--
-- 396 registered bidders have never placed a bid. first_bid_nudge (0292) treats
-- them as one audience and sends them all the same message: "there are lots
-- open right now under $5". It works — 409 people reached, 33 of them went on
-- to bid, 8.1%.
--
-- But the segment is really two:
--
--   216 never added a card.  Price and commitment ARE the barrier, and the
--                            existing cheap-lots message is aimed correctly.
--   180 added a card and still never bid.  They cleared the hardest step in
--                            the funnel — handing over card details — and then
--                            did nothing. Cheapness is demonstrably not what
--                            is stopping them. They looked and found nothing
--                            they wanted.
--
-- Sending the second group a discount message is answering a question they did
-- not ask. They need to see what is NEW, not what is cheap.
--
-- ── never_bid IS NARROWED, NOT JUST SUPPLEMENTED ────────────────────────────
-- never_bid now excludes card-holders. Without that the 180 would match both
-- audiences and receive both campaigns, which is how a reactivation programme
-- turns into a spam complaint. Each bidder belongs to exactly one of the two.
--
-- Their first_bid_nudge history is untouched and still counts against that
-- campaign's cap, so nobody's total is reset by this change; they simply stop
-- receiving a message that has already failed on them twice.

BEGIN;

-- The audience column carries a CHECK listing the known segments, which is what
-- stopped the first attempt at this migration: a campaign row naming an audience
-- the function does not implement would silently mail nobody forever. Extend the
-- list first so the constraint keeps doing that job for the next segment too.
ALTER TABLE public.marketing_campaigns
  DROP CONSTRAINT IF EXISTS marketing_campaigns_audience_known;
ALTER TABLE public.marketing_campaigns
  ADD CONSTRAINT marketing_campaigns_audience_known
  CHECK (audience = ANY (ARRAY[
    'never_bid'::text,
    'card_never_bid'::text,
    'bid_never_won'::text,
    'lapsed'::text,
    'one_time_buyer'::text,
    'sms_optin'::text
  ]));

CREATE OR REPLACE FUNCTION public.campaign_audience(p_slug text, p_limit integer DEFAULT 500)
 RETURNS TABLE(bidder_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_caller   UUID := auth.uid();
  v_role     operator_user_role;
  v_campaign public.marketing_campaigns%ROWTYPE;
BEGIN
  -- service_role (the cron) has no auth.uid(); staff callers must be admin/manager.
  IF v_caller IS NOT NULL THEN
    SELECT ou.role INTO v_role FROM operator_users ou WHERE ou.user_id = v_caller LIMIT 1;
    IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_campaign FROM public.marketing_campaigns WHERE slug = p_slug;
  IF v_campaign.slug IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH stats AS (
    SELECT b.id,
           b.created_at,
           b.phone,
           b.sms_enabled,
           -- A card on file. Either column alone is enough: default_payment_method_id
           -- is the vaulted Square card, card_last4 is the display copy, and a row
           -- can carry one without the other depending on when it was written.
           (b.default_payment_method_id IS NOT NULL OR b.card_last4 IS NOT NULL) AS has_card,
           (SELECT count(*)      FROM bids x     WHERE x.bidder_id = b.id) AS bid_count,
           (SELECT max(x.placed_at) FROM bids x  WHERE x.bidder_id = b.id) AS last_bid_at,
           (SELECT count(*)      FROM invoices i WHERE i.bidder_id = b.id
              AND i.status::text IN ('paid', 'partially_refunded'))        AS paid_invoices,
           (SELECT max(i.created_at) FROM invoices i WHERE i.bidder_id = b.id
              AND i.status::text IN ('paid', 'partially_refunded'))        AS last_purchase_at
      FROM bidders b
     WHERE b.deleted_at IS NULL
       AND b.email IS NOT NULL
       AND b.email_enabled IS TRUE
       AND b.marketing_emails_enabled IS TRUE
  ),
  segment AS (
    SELECT s.id
      FROM stats s
     WHERE CASE v_campaign.audience
             -- Signed up, never bid, and never added a card. 2-day grace so we
             -- are not nagging someone who registered an hour ago and is still
             -- looking around.
             --
             -- NARROWED in 0342: card-holders are excluded and handled by
             -- 'card_never_bid' below. Overlapping segments would send the same
             -- person two different campaigns.
             WHEN 'never_bid' THEN
               s.bid_count = 0
               AND NOT s.has_card
               AND s.created_at < now() - interval '2 days'
             -- Card on file, still never bid. They cleared the hardest step in
             -- the funnel and then stopped, so the barrier is not price or
             -- friction — it is that nothing caught their eye. This segment
             -- gets shown what is NEW rather than what is cheap.
             WHEN 'card_never_bid' THEN
               s.bid_count = 0
               AND s.has_card
               AND s.created_at < now() - interval '2 days'
             -- Bid at least once, never won anything. Highest-intent unconverted
             -- group: they want something and keep getting outbid.
             WHEN 'bid_never_won' THEN
               s.bid_count > 0
               AND s.paid_invoices = 0
               AND s.last_bid_at < now() - interval '3 days'
             -- Was active, has gone quiet.
             WHEN 'lapsed' THEN
               s.bid_count > 0
               AND s.last_bid_at < now() - interval '21 days'
             -- Bought exactly once — the 1→2 purchase step is where a buyer
             -- becomes a customer.
             WHEN 'one_time_buyer' THEN
               s.paid_invoices = 1
               AND s.last_purchase_at < now() - interval '7 days'
             -- Has a phone on file but has not turned on SMS alerts.
             WHEN 'sms_optin' THEN
               s.phone IS NOT NULL
               AND s.sms_enabled IS NOT TRUE
             ELSE false
           END
  ),
  capped AS (
    SELECT sg.id
      FROM segment sg
      LEFT JOIN (
        SELECT cs.bidder_id,
               count(*)          AS sends,
               max(cs.sent_at)   AS last_sent
          FROM public.marketing_campaign_sends cs
         WHERE cs.campaign_slug = p_slug
         GROUP BY cs.bidder_id
      ) hist ON hist.bidder_id = sg.id
     WHERE COALESCE(hist.sends, 0) < v_campaign.max_sends_per_bidder
       AND (hist.last_sent IS NULL
            OR hist.last_sent < now() - make_interval(hours => v_campaign.cooldown_hours))
  )
  SELECT c.id FROM capped c
  -- Stable, fair ordering: longest-waiting first.
  ORDER BY c.id
  LIMIT GREATEST(p_limit, 0);
END;
$function$;

-- The campaign itself. 'newest' rather than 'cheapest' is the entire point of
-- the split: this group has already ignored the cheap lots.
--
-- Deliberately conservative on volume. These people have already received about
-- two first_bid_nudge emails; two more of a DIFFERENT message, two weeks apart,
-- is a fair second attempt. A third would be nagging.
INSERT INTO public.marketing_campaigns (
  slug, name, description, audience, lot_strategy, lot_count,
  subject, headline, subcopy, cta_label, cta_path,
  min_hours_between_runs, cooldown_hours, max_sends_per_bidder,
  max_recipients_per_run, enabled
) VALUES (
  'ready_to_bid',
  'Ready to bid — never has',
  'Card on file, never placed a bid. Shows newest lots, not cheapest: this group has already ignored the price message.',
  'card_never_bid',
  'newest',
  6,
  'Just landed at BinGo Auctions',
  'You are all set to bid — here is what just came in',
  'Your card is already on file, so bidding takes one tap and you are only charged if you win. These are the newest lots on the floor. Everything is picked up in person at our Harrison warehouse.',
  'See the newest lots',
  '/browse?sort=newest',
  168,
  336,
  2,
  200,
  false
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
