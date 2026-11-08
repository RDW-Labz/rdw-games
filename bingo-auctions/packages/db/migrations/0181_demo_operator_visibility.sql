-- ============================================================================
-- Migration 0181: Demo operator visibility (H4-c — reviewer-scoped demo hide)
--
-- GOAL
-- ----
-- Hide the demo operator (Demo Auctioneer, id 99999999-9999-9999-9999-999999999999)
-- from the PUBLIC storefront so real bidders never see the permanent
-- "ClovrBid Demo Auction — App Review" auction/lots, WHILE the Apple/Google
-- reviewer bidder account (reviewer@clovrbid.com) CAN still see + bid them.
--
-- Per docs/plans/PATCH-live-test-feedback-2026-06-03.md §5.1 decision H4 and
-- docs/audits/redteam-plans-2026-06-03.md (MON-5), this is the "(b)+(c)" path:
-- the seed-fix (close_at, handled in U1/H4-b separately) makes the lots
-- biddable; THIS migration adds the reviewer-scoped visibility so the demo is
-- invisible to the public but visible to reviewers.
--
-- TWO NEW FLAGS (neither exists today — confirmed by grep over all migrations):
--   operators.is_demo    BOOLEAN — marks the demo/sandbox operator.
--   bidders.is_reviewer  BOOLEAN — marks the Apple/Google reviewer account(s).
-- The seed (scripts/seed-app-reviewer-fixtures.mjs) sets both.
--
-- RLS CHANGES (surgical — preserve every existing predicate, AND-in the guard):
--   auctions_bidder_read_published
--   lots_bidder_read_published
-- A demo operator's auction/lot row becomes readable by a bidder ONLY when:
--   NOT <that operator>.is_demo   OR   the caller is a reviewer bidder.
-- For every NON-demo operator the guard is `NOT false` = TRUE, so visibility of
-- all real content is byte-for-byte unchanged.
--
-- WAREHOUSES / BINS: intentionally NOT changed. Their bidder-read policies
-- (warehouses_bidder_read / bins_bidder_read, mig 0094 §8) are already gated by
-- bidder_has_warehouse_access(), which requires a paid/pending/partially_refunded
-- invoice at that warehouse. A non-reviewer bidder can never reach the demo
-- warehouse/bins (they can't see the demo lots to win them), so no demo leak
-- exists there.
--
-- WEB STOREFRONT: clovrbid.com/browse loaders use the service-role client
-- (getSupabaseAdmin), which BYPASSES RLS. The demo exclusion for web is enforced
-- in-query in apps/operator-web/src/app/(public)/browse/page.tsx (this migration
-- does NOT cover the web path). Reviewers test via the mobile bidder app per
-- docs/APP_REVIEWER_NOTES.md, so web excludes demo unconditionally.
--
-- RLS PERF: helper calls are wrapped in (SELECT ...) per mig 0133 so the planner
-- evaluates them once-per-query (initPlan), not once-per-row.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP POLICY IF EXISTS / CREATE POLICY.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Flags
-- ---------------------------------------------------------------------------

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN operators.is_demo IS
  'TRUE for the demo/sandbox operator (Demo Auctioneer). Demo operators are '
  'hidden from the public storefront (web query filter) and from non-reviewer '
  'bidders (RLS), but remain visible to reviewer bidders (bidders.is_reviewer) '
  'so Apple/Google reviewers can test bidding. Set by seed-app-reviewer-fixtures.mjs.';

ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS is_reviewer BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN bidders.is_reviewer IS
  'TRUE for the Apple/Google app-reviewer bidder account(s) (reviewer@clovrbid.com). '
  'Reviewer bidders can read demo-operator auctions/lots that are hidden from '
  'the public. Set by seed-app-reviewer-fixtures.mjs.';

-- ---------------------------------------------------------------------------
-- 2. RLS: auctions_bidder_read_published
-- ---------------------------------------------------------------------------
-- BEFORE (final version, mig 0133:248-253):
--   USING (
--     (SELECT is_bidder()) AND status IN ('scheduled', 'live', 'closed')
--   )
-- AFTER: identical predicate, AND-ed with the demo/reviewer guard.
-- The guard is TRUE for every non-demo operator (operators.is_demo=false), so
-- only demo-operator auctions are newly restricted — to reviewer bidders.

DROP POLICY IF EXISTS auctions_bidder_read_published ON public.auctions;
CREATE POLICY auctions_bidder_read_published ON public.auctions
  FOR SELECT
  USING (
    (SELECT is_bidder())
    AND status IN ('scheduled', 'live', 'closed')
    AND (
      NOT EXISTS (
        SELECT 1 FROM operators o
        WHERE o.id = auctions.operator_id
          AND o.is_demo
      )
      OR EXISTS (
        SELECT 1 FROM bidders b
        WHERE b.id = (SELECT auth.uid())
          AND b.is_reviewer
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. RLS: lots_bidder_read_published
-- ---------------------------------------------------------------------------
-- BEFORE (final version, mig 0133:296-307 — carries the 0013 early-access clause):
--   USING (
--     (SELECT is_bidder())
--     AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted')
--     AND (
--       early_access_until IS NULL
--       OR early_access_until <= now()
--       OR is_subscriber(operator_id)
--     )
--   )
-- AFTER: every existing predicate reproduced verbatim, AND-ed with the same
-- demo/reviewer guard. Non-demo lots unchanged.

DROP POLICY IF EXISTS lots_bidder_read_published ON public.lots;
CREATE POLICY lots_bidder_read_published ON public.lots
  FOR SELECT
  USING (
    (SELECT is_bidder())
    AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted')
    AND (
      early_access_until IS NULL
      OR early_access_until <= now()
      OR is_subscriber(operator_id)
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM operators o
        WHERE o.id = lots.operator_id
          AND o.is_demo
      )
      OR EXISTS (
        SELECT 1 FROM bidders b
        WHERE b.id = (SELECT auth.uid())
          AND b.is_reviewer
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Supporting index
-- ---------------------------------------------------------------------------
-- The demo-guard subquery filters operators by is_demo. Only a handful of
-- operators exist, so a partial index on the demo rows keeps the EXISTS probe
-- cheap without bloating writes on the common (non-demo) path.

CREATE INDEX IF NOT EXISTS operators_is_demo_idx
  ON operators (id) WHERE is_demo;

COMMIT;
