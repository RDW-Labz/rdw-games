-- 0323 — social_posts: the record of what we published, where, and what it did.
--
-- GOAL (2026-08-14): 30 new bidders/day. Measured baseline over the trailing 21
-- days is ~10.5/day (range 5-20), so this is roughly a 3x, sustained.
--
-- Organic posting alone will not deliver that — it reaches people who already
-- follow BinGo, and most of them already bid. It is worth building for bid
-- velocity on closing lots, and as the organic layer under paid distribution,
-- but the incremental reach has to come from Meta catalog ads pointed at
-- /catalog/meta.csv (which already handles auction-close takedown).
--
-- This table therefore serves BOTH: every post carries a campaign-tagged link,
-- so organic and paid land in the same attribution model and we can compare
-- cost-per-signup honestly instead of guessing which one moved the number.
--
-- ── WHY A TABLE AND NOT FIRE-AND-FORGET ──────────────────────────────────────
-- The marketing digest (0230) already learned this: sends need a history, or
-- nobody can answer "did it go out?" and duplicate sends creep in. Three things
-- specifically:
--
--   1. IDEMPOTENCY. A retried worker run must not double-post a lot. The
--      unique index on (operator_id, platform, lot_id, auction_id) makes a
--      second attempt a no-op rather than a duplicate on the page.
--   2. TAKEDOWN. An auction closes and the post should stop driving traffic to
--      a dead lot. We need the remote post id to delete it, same lesson the
--      catalog feed's takedown encodes.
--   3. ATTRIBUTION. Without storing the exact tagged URL we published, signups
--      cannot be traced back to a post, and "is this working?" stays a matter
--      of opinion.
--
-- ── STATUS LIFECYCLE ─────────────────────────────────────────────────────────
--   queued -> posted -> taken_down
--          \-> failed (with error, retryable)
--          \-> skipped (deliberately not posted; reason recorded)
--
-- No token, page id or secret is stored here. Those live in Worker secrets
-- alongside SQUARE_* — a table read by any operator staff is the wrong place
-- for a credential that can post as the business.

BEGIN;

CREATE TABLE IF NOT EXISTS public.social_posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id    uuid NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,

  -- What we posted about. lot_id is nullable: auction-level posts ("42 lots
  -- close tonight") are a different and often better-performing shape than
  -- one-lot-one-post, and both belong in the same history.
  lot_id         uuid REFERENCES public.lots(id) ON DELETE SET NULL,
  auction_id     uuid REFERENCES public.auctions(id) ON DELETE SET NULL,

  platform       text NOT NULL
                   CHECK (platform IN ('facebook_page', 'instagram')),
  -- 'lot' | 'auction_closing' | 'auction_open' — what template composed it.
  post_kind      text NOT NULL DEFAULT 'lot'
                   CHECK (post_kind IN ('lot', 'auction_closing', 'auction_open')),

  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','posted','failed','skipped','taken_down')),

  -- Exactly what went out, kept verbatim. When engagement is bad we need to
  -- read the copy that produced it, not re-derive what we think we sent.
  message        text,
  image_urls     text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- The campaign-tagged destination. This is the join key for attribution.
  target_url     text,

  -- Remote identity, required for takedown and for pulling engagement later.
  remote_post_id text,
  permalink      text,

  error          text,
  skip_reason    text,

  scheduled_for  timestamptz,
  posted_at      timestamptz,
  taken_down_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- A posted row must carry the id needed to take it down again.
  CONSTRAINT social_posts_posted_has_remote_id
    CHECK (status <> 'posted' OR remote_post_id IS NOT NULL),
  -- A post is about a lot, an auction, or both — never neither.
  CONSTRAINT social_posts_has_subject
    CHECK (lot_id IS NOT NULL OR auction_id IS NOT NULL)
);

-- IDEMPOTENCY. Partial: only live rows reserve the slot, so a skipped or failed
-- attempt can be retried, and a taken-down lot can be reposted if relisted.
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_one_live_per_lot_platform
  ON public.social_posts (operator_id, platform, lot_id, auction_id)
  WHERE status IN ('queued', 'posted') AND lot_id IS NOT NULL;

-- The worker's queue scan.
CREATE INDEX IF NOT EXISTS social_posts_due
  ON public.social_posts (status, scheduled_for)
  WHERE status = 'queued';

-- Takedown sweep: find posted rows whose auction has ended.
CREATE INDEX IF NOT EXISTS social_posts_posted_by_auction
  ON public.social_posts (auction_id)
  WHERE status = 'posted';

CREATE INDEX IF NOT EXISTS social_posts_operator_created
  ON public.social_posts (operator_id, created_at DESC);

COMMENT ON TABLE public.social_posts IS
  '0323: history of organic social posts (FB page / Instagram) — idempotency, '
  'takedown after auction close, and campaign-tagged attribution shared with '
  'paid catalog ads. Credentials live in Worker secrets, never here.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Follows 0223/0317: operator staff read their own operator's rows; only
-- admin/manager may write from a session; the worker uses service_role.
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_posts_select_staff ON public.social_posts;
CREATE POLICY social_posts_select_staff ON public.social_posts
  FOR SELECT TO authenticated
  USING (operator_id = current_operator_id());

DROP POLICY IF EXISTS social_posts_write_managers ON public.social_posts;
CREATE POLICY social_posts_write_managers ON public.social_posts
  FOR ALL TO authenticated
  USING (
    operator_id = current_operator_id()
    AND EXISTS (
      SELECT 1 FROM operator_users ou
       WHERE ou.user_id = auth.uid()
         AND ou.operator_id = current_operator_id()
         AND ou.role IN ('admin', 'manager')
    )
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND EXISTS (
      SELECT 1 FROM operator_users ou
       WHERE ou.user_id = auth.uid()
         AND ou.operator_id = current_operator_id()
         AND ou.role IN ('admin', 'manager')
    )
  );

GRANT SELECT ON public.social_posts TO authenticated;
GRANT ALL    ON public.social_posts TO service_role;

-- ── ATTRIBUTION ──────────────────────────────────────────────────────────────
-- The whole point of the 30/day goal is knowing whether we hit it and what
-- moved it. bidders has no acquisition-source column today, so every signup is
-- currently unattributable — organic, paid and word-of-mouth look identical.
--
-- Nullable and free-form on purpose: it is populated from the campaign tag on
-- the landing URL, and an unrecognized or absent tag must never block a signup.
ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS acquisition_source   text,
  ADD COLUMN IF NOT EXISTS acquisition_campaign text;

COMMENT ON COLUMN public.bidders.acquisition_source IS
  '0323: where this bidder came from (utm_source), e.g. facebook_page, '
  'instagram, meta_ads. NULL = unattributed, which is the honest default for '
  'everyone who signed up before this shipped.';

CREATE INDEX IF NOT EXISTS bidders_acquisition_created
  ON public.bidders (acquisition_source, created_at DESC)
  WHERE acquisition_source IS NOT NULL;

COMMIT;
