-- ============================================================================
-- Migration 0292 — internal marketing campaign engine
--
-- WHY -----------------------------------------------------------------------
--
-- BinGo has exactly ONE recurring campaign today: the closing-soon digest
-- (0230, `runMarketingDigestAuto`) which self-gates to at most one send every
-- 72h. It is content-driven and works, but it speaks to everyone identically
-- and only ever says "these lots are ending".
--
-- Measured on prod 2026-07-27 (627 bidders, 624 marketable):
--
--   never placed a single bid ....... 268  (43%)   ← the actual leak
--   bid but never bought ........... 108  (17%)
--   bought exactly once ............  53   (8%)
--   repeat buyers .................. 198  (32%)
--   lapsed >21d since last bid .....  11   (2%)
--
-- So retention is NOT the problem — 198 repeat buyers against 11 lapsed is a
-- healthy core. The problem is ACTIVATION: 43% of everyone who ever signed up
-- has never bid once. The single highest-value campaign is therefore a
-- first-bid nudge, not a win-back, and the second is rescuing the 108 who bid
-- and lost. This migration builds the engine and seeds both, plus win-back and
-- second-purchase for completeness.
--
-- DESIGN --------------------------------------------------------------------
--
-- Table-driven, not one-function-per-campaign. A campaign is a ROW: audience +
-- lot strategy + copy + cadence. Adding the 5th campaign is an INSERT, not a
-- deploy. All delivery reuses the proven rails — notifications_outbox rows
-- drained by email-drain, one generalized `marketing_campaign` template.
--
-- Every send is gated three ways so no campaign can ever blast the list:
--   1. campaign.enabled                     — owner switch, OFF for all seeds
--   2. min_hours_between_runs                — campaign-level cadence
--   3. cooldown_hours + max_sends_per_bidder — per-person frequency cap,
--      enforced inside campaign_audience() so it cannot be bypassed by a
--      caller that forgets to check.
--
-- Seeds ship DISABLED. Turning one on is a deliberate act in /marketing —
-- nothing starts emailing 624 people because a migration ran.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Campaign definitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  slug                  TEXT PRIMARY KEY,
  name                  TEXT        NOT NULL,
  description           TEXT        NOT NULL DEFAULT '',
  -- Which bidders: resolved by campaign_audience() below.
  audience              TEXT        NOT NULL,
  -- Which lots to feature: 'closing_soon' | 'cheapest' | 'newest' | 'none'.
  lot_strategy          TEXT        NOT NULL DEFAULT 'closing_soon',
  lot_count             INT         NOT NULL DEFAULT 6 CHECK (lot_count BETWEEN 0 AND 24),
  -- Copy. Kept in the row so the owner can retune tone without a deploy.
  subject               TEXT        NOT NULL,
  headline              TEXT        NOT NULL,
  subcopy               TEXT        NOT NULL DEFAULT '',
  cta_label             TEXT        NOT NULL DEFAULT 'Browse auctions',
  cta_path              TEXT        NOT NULL DEFAULT '/browse',
  -- Cadence.
  min_hours_between_runs  INT       NOT NULL DEFAULT 72  CHECK (min_hours_between_runs >= 1),
  cooldown_hours          INT       NOT NULL DEFAULT 336 CHECK (cooldown_hours >= 1),
  max_sends_per_bidder    INT       NOT NULL DEFAULT 3   CHECK (max_sends_per_bidder >= 1),
  -- Safety: refuse to run if the audience is larger than this (guards against
  -- an audience-SQL mistake turning into a 600-person blast).
  max_recipients_per_run  INT       NOT NULL DEFAULT 300 CHECK (max_recipients_per_run >= 1),
  enabled               BOOLEAN     NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marketing_campaigns_audience_known CHECK (
    audience IN ('never_bid', 'bid_never_won', 'lapsed', 'one_time_buyer', 'sms_optin')
  ),
  CONSTRAINT marketing_campaigns_strategy_known CHECK (
    lot_strategy IN ('closing_soon', 'cheapest', 'newest', 'none')
  )
);

DROP TRIGGER IF EXISTS marketing_campaigns_set_updated_at ON public.marketing_campaigns;
CREATE TRIGGER marketing_campaigns_set_updated_at
  BEFORE UPDATE ON public.marketing_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Run + per-recipient logs
--
-- `sends` is the frequency-cap ledger AND the reporting substrate. It is the
-- reason a campaign can promise "at most 3 emails ever, no more than one a
-- fortnight" and actually keep it across restarts and manual sends.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_campaign_runs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_slug   TEXT        NOT NULL REFERENCES public.marketing_campaigns(slug) ON DELETE CASCADE,
  triggered_by    TEXT        NOT NULL DEFAULT 'auto' CHECK (triggered_by IN ('auto', 'manual')),
  recipient_count INT         NOT NULL DEFAULT 0,
  lot_count       INT         NOT NULL DEFAULT 0,
  subject         TEXT        NOT NULL DEFAULT '',
  -- Populated when a run declines to send, so the console can show WHY.
  skipped_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_campaign_runs_slug_time
  ON public.marketing_campaign_runs (campaign_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS public.marketing_campaign_sends (
  campaign_slug TEXT        NOT NULL REFERENCES public.marketing_campaigns(slug) ON DELETE CASCADE,
  bidder_id     UUID        NOT NULL REFERENCES public.bidders(id) ON DELETE CASCADE,
  run_id        UUID        NOT NULL REFERENCES public.marketing_campaign_runs(id) ON DELETE CASCADE,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_slug, bidder_id, run_id)
);

-- Cooldown / cap lookups are always "this campaign, this bidder, how recently".
CREATE INDEX IF NOT EXISTS marketing_campaign_sends_slug_bidder_time
  ON public.marketing_campaign_sends (campaign_slug, bidder_id, sent_at DESC);

-- ---------------------------------------------------------------------------
-- 3. campaign_audience(slug, limit) — who should get this campaign RIGHT NOW
--
-- Returns bidder ids that are (a) in the campaign's segment, (b) marketable,
-- and (c) inside their frequency cap. Cap enforcement lives HERE, not in the
-- caller, so no code path can accidentally skip it.
--
-- SECURITY DEFINER + admin/manager gate: this returns bidder ids, and the
-- bidders table has no operator SELECT policy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaign_audience(
  p_slug  TEXT,
  p_limit INT DEFAULT 500
)
RETURNS TABLE (bidder_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
             -- Signed up, never bid. 2-day grace so we are not nagging someone
             -- who registered an hour ago and is still looking around.
             WHEN 'never_bid' THEN
               s.bid_count = 0
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
             -- Has a phone on file but has not turned on SMS alerts. 421 of 627
             -- bidders have a number and only 2 have opted in, so the SMS
             -- channel is effectively dark until this runs.
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
$$;

REVOKE ALL ON FUNCTION public.campaign_audience(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.campaign_audience(TEXT, INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.campaign_audience(TEXT, INT) IS
  '0292: bidder ids eligible for a campaign right now — segment membership, '
  'marketing opt-in, and the per-bidder cooldown/max-sends cap, all enforced '
  'in one place. Admin/manager only for staff callers.';

-- ---------------------------------------------------------------------------
-- 4. campaign_performance() — did any of this work?
--
-- Attribution is deliberately simple and honest: for each campaign, how many
-- people we emailed, and how many of them placed a bid or paid an invoice
-- AFTER their most recent campaign email. That is correlation, not proof —
-- there is no click tracking on these yet — so the column names say "after",
-- not "because".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaign_performance()
RETURNS TABLE (
  slug              TEXT,
  name              TEXT,
  enabled           BOOLEAN,
  audience          TEXT,
  audience_now      INT,
  runs              INT,
  emails_sent       INT,
  bidders_reached   INT,
  bid_after         INT,
  bought_after      INT,
  revenue_after_cents BIGINT,
  last_run_at       TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_caller UUID := auth.uid();
  v_role   operator_user_role;
BEGIN
  IF v_caller IS NOT NULL THEN
    SELECT ou.role INTO v_role FROM operator_users ou WHERE ou.user_id = v_caller LIMIT 1;
    IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH last_send AS (
    SELECT cs.campaign_slug, cs.bidder_id, max(cs.sent_at) AS sent_at
      FROM public.marketing_campaign_sends cs
     GROUP BY cs.campaign_slug, cs.bidder_id
  ),
  outcomes AS (
    SELECT ls.campaign_slug,
           ls.bidder_id,
           EXISTS (SELECT 1 FROM bids b
                    WHERE b.bidder_id = ls.bidder_id AND b.placed_at > ls.sent_at) AS did_bid,
           EXISTS (SELECT 1 FROM invoices i
                    WHERE i.bidder_id = ls.bidder_id AND i.created_at > ls.sent_at
                      AND i.status::text IN ('paid', 'partially_refunded'))         AS did_buy,
           COALESCE((SELECT sum(i.total_cents) FROM invoices i
                      WHERE i.bidder_id = ls.bidder_id AND i.created_at > ls.sent_at
                        AND i.status::text IN ('paid', 'partially_refunded')), 0)   AS rev
      FROM last_send ls
  )
  SELECT c.slug,
         c.name,
         c.enabled,
         c.audience,
         -- Audience size ignoring caps: "how many people are in this segment".
         (SELECT count(*)::INT FROM public.campaign_audience(c.slug, 100000))       AS audience_now,
         (SELECT count(*)::INT FROM public.marketing_campaign_runs r
           WHERE r.campaign_slug = c.slug AND r.skipped_reason IS NULL)             AS runs,
         (SELECT count(*)::INT FROM public.marketing_campaign_sends s
           WHERE s.campaign_slug = c.slug)                                         AS emails_sent,
         (SELECT count(DISTINCT s.bidder_id)::INT FROM public.marketing_campaign_sends s
           WHERE s.campaign_slug = c.slug)                                         AS bidders_reached,
         COALESCE((SELECT count(*)::INT FROM outcomes o
                    WHERE o.campaign_slug = c.slug AND o.did_bid), 0)              AS bid_after,
         COALESCE((SELECT count(*)::INT FROM outcomes o
                    WHERE o.campaign_slug = c.slug AND o.did_buy), 0)              AS bought_after,
         COALESCE((SELECT sum(o.rev)::BIGINT FROM outcomes o
                    WHERE o.campaign_slug = c.slug), 0)                            AS revenue_after_cents,
         (SELECT max(r.created_at) FROM public.marketing_campaign_runs r
           WHERE r.campaign_slug = c.slug AND r.skipped_reason IS NULL)            AS last_run_at
    FROM public.marketing_campaigns c
   ORDER BY c.enabled DESC, c.slug;
END;
$$;

REVOKE ALL ON FUNCTION public.campaign_performance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.campaign_performance() TO authenticated, service_role;

COMMENT ON FUNCTION public.campaign_performance() IS
  '0292: per-campaign audience size, emails sent, and bid/purchase/revenue '
  'activity AFTER each recipient''s most recent campaign email. Correlation, '
  'not attribution — there is no click tracking on these yet.';

-- ---------------------------------------------------------------------------
-- 5. RLS — service_role and staff read via the RPCs; no bidder ever sees these.
-- ---------------------------------------------------------------------------
ALTER TABLE public.marketing_campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaign_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaign_sends  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_campaigns_staff_read ON public.marketing_campaigns;
CREATE POLICY marketing_campaigns_staff_read ON public.marketing_campaigns
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM operator_users ou WHERE ou.user_id = auth.uid()));

DROP POLICY IF EXISTS marketing_campaigns_admin_write ON public.marketing_campaigns;
CREATE POLICY marketing_campaigns_admin_write ON public.marketing_campaigns
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM operator_users ou
                  WHERE ou.user_id = auth.uid() AND ou.role IN ('admin', 'manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM operator_users ou
                       WHERE ou.user_id = auth.uid() AND ou.role IN ('admin', 'manager')));

DROP POLICY IF EXISTS marketing_campaign_runs_staff_read ON public.marketing_campaign_runs;
CREATE POLICY marketing_campaign_runs_staff_read ON public.marketing_campaign_runs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM operator_users ou WHERE ou.user_id = auth.uid()));

-- marketing_campaign_sends holds bidder_id (PII-adjacent) — RPC access only,
-- no direct staff SELECT policy. RLS on with no policy = deny for authenticated.

-- ---------------------------------------------------------------------------
-- 6. Seed the campaigns — ALL DISABLED.
--
-- Copy is written to be useful rather than shouty: every one leads with what
-- the bidder gets, and the cadence caps mean nobody can receive more than a
-- handful of these ever.
-- ---------------------------------------------------------------------------
INSERT INTO public.marketing_campaigns (
  slug, name, description, audience, lot_strategy, lot_count,
  subject, headline, subcopy, cta_label, cta_path,
  min_hours_between_runs, cooldown_hours, max_sends_per_bidder, max_recipients_per_run
) VALUES
  -- #1 THE BIG ONE: 268 people (43%) have never bid. Lead with cheap lots so
  -- the first bid costs almost nothing — the barrier is "will I get stuck with
  -- something", not price.
  ('first_bid_nudge',
   'First bid nudge',
   'Signed up but never bid. Largest segment on the platform (268 / 43% as of 2026-07-27) and the biggest single growth lever. Features the cheapest live lots so the first bid is a $1 decision.',
   'never_bid', 'cheapest', 6,
   'There are lots open right now under $5',
   'Your first bid is easier than you think',
   'Most BinGo lots start at a dollar. Bid, win, and pick up locally — no shipping, no surprises. Here are some of the cheapest lots open right now.',
   'Place your first bid', '/browse',
   72, 336, 3, 300),

  -- #2 108 people bid and never won. They already want something.
  ('outbid_comeback',
   'Outbid comeback',
   'Bid at least once but never won. Highest-intent unconverted group — they want something and keep losing it. Features lots closing soon so there is a concrete next chance.',
   'bid_never_won', 'closing_soon', 6,
   'Still time to win one',
   'You have been outbid — here is another shot',
   'These lots are closing soon and still winnable. Set your max and let it ride.',
   'See what is closing', '/browse',
   72, 240, 4, 300),

  -- #3 Only 11 people, but cheap to run and it is the classic win-back.
  ('win_back',
   'Win-back (lapsed bidders)',
   'Bid before but nothing in 21+ days. Small segment (11 as of 2026-07-27) because retention is genuinely healthy — kept for coverage, not because it is the priority.',
   'lapsed', 'closing_soon', 6,
   'New pallets since you were last here',
   'We have restocked since your last bid',
   'Fresh inventory lands every week. Here is what is live right now.',
   'See what is new', '/browse',
   168, 720, 2, 200),

  -- #4 1→2 purchase is where a buyer becomes a customer.
  ('second_purchase',
   'Second purchase nudge',
   'Bought exactly once, 7+ days ago. The 1→2 step is the biggest jump in lifetime value; 53 bidders sit on it.',
   'one_time_buyer', 'newest', 6,
   'Newly listed at BinGo Auctions',
   'Thanks for your first win — here is what just landed',
   'You already know how pickup works. Here is the freshest inventory on the site.',
   'Browse new arrivals', '/browse',
   168, 504, 3, 200),

  -- #5 Unlocks a channel that is currently dark: 421 bidders have a phone on
  -- file, 2 have SMS on, and the Twilio drain has never sent a message.
  ('sms_optin_push',
   'Turn on text alerts',
   'Has a phone on file but SMS alerts off. 421 of 627 bidders have a number and only 2 have opted in, so the SMS channel is dark. Text alerts are the single best anti-snipe tool for a bidder.',
   'sms_optin', 'none', 0,
   'Get a text when you are outbid',
   'Never lose a lot to a last-second bid',
   'Turn on text alerts and we will message you the moment someone outbids you, plus a heads-up before your lots close. Two taps in your profile.',
   'Turn on text alerts', '/profile',
   336, 2160, 2, 300)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
