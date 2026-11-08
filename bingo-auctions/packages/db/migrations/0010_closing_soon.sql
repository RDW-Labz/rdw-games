-- ============================================================================
-- Closing-soon push: a watchlist-aware notification kind.
--
-- Adds 'closing_soon' to notification_kind. The worker enqueues one row per
-- (bidder, lot) when a watched lot is within CLOSING_SOON_MINUTES of close_at,
-- with idempotency 'closing_soon:<bidder>:<lot>:<close_at>' so re-runs of the
-- worker poll don't double-fire on the same close_at value.
--
-- We do NOT fire closing_soon if the bidder is already the leader on the lot
-- (no panic for the bidder who's already set their max bid).
-- ============================================================================

-- ALTER TYPE in Postgres requires a separate transaction from usage of the
-- new value. We're in a migration, so it's fine.
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'closing_soon';
