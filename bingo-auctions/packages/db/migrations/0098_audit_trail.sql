-- ============================================================================
-- Migration 0098 — Audit trail for status transitions
--
-- Background (docs/auction-lot-audit-plan.md, BUG-ARCH-04):
--   `bid_records` is the only immutable history in the platform today.
--   Every other state transition on lots, auctions, and invoices is a
--   destructive UPDATE. After a paid auction:
--     - You can see the winning bid.
--     - You cannot reconstruct WHEN the lot went 'won', WHEN the invoice
--       was built, WHEN the bidder paid — only the final timestamps.
--     - You cannot see who canceled an auction or a lot — cancelLot just
--       writes status='canceled' with no actor capture.
--     - First Stripe chargeback dispute or state-AG inquiry that wants
--       "who canceled this and when" won't have an answer.
--
-- This migration adds three audit tables + AFTER UPDATE triggers that
-- capture every status transition. RLS scoping mirrors the parent table:
-- operator staff read their own operator's history; bidders read the
-- history of lots/invoices they own.
--
-- We deliberately keep these BIGSERIAL tables (not UUID PK) because:
--   - The audit log is append-only and never referenced from other rows
--     by id (only ever queried by lot_id / auction_id / invoice_id).
--   - BIGSERIAL is half the storage of UUID and clusters naturally.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. lot_status_history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lot_status_history (
  id          BIGSERIAL    PRIMARY KEY,
  lot_id      UUID         NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT         NOT NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  changed_by  UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Free-form context. Triggers populate with whatever's relevant:
  --   { current_bid_id, winner_bidder_id, bid_count, intake_bin_id, ... }
  -- Bigger than a single text 'reason' column; smaller than a separate
  -- key-value table; queryable via JSONB operators.
  context     JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS lot_status_history_lot_idx
  ON lot_status_history(lot_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS lot_status_history_to_status_idx
  ON lot_status_history(to_status, changed_at DESC);

CREATE OR REPLACE FUNCTION log_lot_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO lot_status_history (
      lot_id, from_status, to_status, changed_by, context
    )
    VALUES (
      NEW.id,
      OLD.status::TEXT,
      NEW.status::TEXT,
      auth.uid(),
      jsonb_build_object(
        'current_bid_id', NEW.current_bid_id,
        'winner_bidder_id', NEW.winner_bidder_id,
        'bid_count', NEW.bid_count,
        'intake_bin_id', NEW.intake_bin_id,
        'auction_id', NEW.auction_id,
        'relist_count', NEW.relist_count,
        'relisted_from_lot_id', NEW.relisted_from_lot_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_status_history ON lots;
CREATE TRIGGER lots_status_history
  AFTER UPDATE OF status ON lots
  FOR EACH ROW EXECUTE FUNCTION log_lot_status_change();

-- Also capture INSERT events so we have a "created" entry for every lot.
-- Useful for the timeline UI — without this the first event we'd see
-- would be the second state transition.
CREATE OR REPLACE FUNCTION log_lot_initial_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO lot_status_history (
    lot_id, from_status, to_status, changed_by, context
  )
  VALUES (
    NEW.id, NULL, NEW.status::TEXT, auth.uid(),
    jsonb_build_object(
      'lot_code', NEW.lot_code,
      'operator_id', NEW.operator_id,
      'warehouse_id', NEW.warehouse_id,
      'auction_id', NEW.auction_id,
      'source', NEW.source,
      'relisted_from_lot_id', NEW.relisted_from_lot_id
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_initial_status_history ON lots;
CREATE TRIGGER lots_initial_status_history
  AFTER INSERT ON lots
  FOR EACH ROW EXECUTE FUNCTION log_lot_initial_status();

-- ---------------------------------------------------------------------------
-- 2. auction_status_history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auction_status_history (
  id          BIGSERIAL    PRIMARY KEY,
  auction_id  UUID         NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT         NOT NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  changed_by  UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  context     JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS auction_status_history_auction_idx
  ON auction_status_history(auction_id, changed_at DESC);

CREATE OR REPLACE FUNCTION log_auction_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO auction_status_history (
      auction_id, from_status, to_status, changed_by, context
    )
    VALUES (
      NEW.id, OLD.status::TEXT, NEW.status::TEXT, auth.uid(),
      jsonb_build_object(
        'ends_at', NEW.ends_at,
        'last_lot_ends_at', NEW.last_lot_ends_at,
        'closed_at', NEW.closed_at,
        'canceled_at', NEW.canceled_at,
        'canceled_by', NEW.canceled_by
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auctions_status_history ON auctions;
CREATE TRIGGER auctions_status_history
  AFTER UPDATE OF status ON auctions
  FOR EACH ROW EXECUTE FUNCTION log_auction_status_change();

CREATE OR REPLACE FUNCTION log_auction_initial_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO auction_status_history (
    auction_id, from_status, to_status, changed_by, context
  )
  VALUES (
    NEW.id, NULL, NEW.status::TEXT, auth.uid(),
    jsonb_build_object(
      'title', NEW.title,
      'operator_id', NEW.operator_id,
      'warehouse_id', NEW.warehouse_id,
      'starts_at', NEW.starts_at,
      'ends_at', NEW.ends_at,
      'format', NEW.format
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auctions_initial_status_history ON auctions;
CREATE TRIGGER auctions_initial_status_history
  AFTER INSERT ON auctions
  FOR EACH ROW EXECUTE FUNCTION log_auction_initial_status();

-- ---------------------------------------------------------------------------
-- 3. invoice_status_history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_status_history (
  id          BIGSERIAL    PRIMARY KEY,
  invoice_id  UUID         NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT         NOT NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  changed_by  UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  context     JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS invoice_status_history_invoice_idx
  ON invoice_status_history(invoice_id, changed_at DESC);

CREATE OR REPLACE FUNCTION log_invoice_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO invoice_status_history (
      invoice_id, from_status, to_status, changed_by, context
    )
    VALUES (
      NEW.id, OLD.status::TEXT, NEW.status::TEXT, auth.uid(),
      jsonb_build_object(
        'total_cents', NEW.total_cents,
        'paid_at', NEW.paid_at,
        'refunded_at', NEW.refunded_at,
        'stripe_payment_intent_id', NEW.stripe_payment_intent_id,
        'stripe_charge_id', NEW.stripe_charge_id,
        'fulfillment_method', NEW.fulfillment_method,
        'shipping_cents', NEW.shipping_cents
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_status_history ON invoices;
CREATE TRIGGER invoices_status_history
  AFTER UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION log_invoice_status_change();

CREATE OR REPLACE FUNCTION log_invoice_initial_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO invoice_status_history (
    invoice_id, from_status, to_status, changed_by, context
  )
  VALUES (
    NEW.id, NULL, NEW.status::TEXT, auth.uid(),
    jsonb_build_object(
      'operator_id', NEW.operator_id,
      'bidder_id', NEW.bidder_id,
      'auction_id', NEW.auction_id,
      'subtotal_cents', NEW.subtotal_cents,
      'buyer_premium_cents', NEW.buyer_premium_cents,
      'total_cents', NEW.total_cents
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_initial_status_history ON invoices;
CREATE TRIGGER invoices_initial_status_history
  AFTER INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION log_invoice_initial_status();

-- ---------------------------------------------------------------------------
-- 4. RLS policies
-- ---------------------------------------------------------------------------
-- Three patterns:
--   1. Operator staff read their own operator's history (via parent-table join)
--   2. Bidders read history for lots/invoices they own
--   3. No INSERT/UPDATE/DELETE from app code — triggers own those.

ALTER TABLE lot_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_status_history ENABLE ROW LEVEL SECURITY;

-- lot_status_history: operator staff via lot's operator
DROP POLICY IF EXISTS lot_status_history_operator_read ON lot_status_history;
CREATE POLICY lot_status_history_operator_read ON lot_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = lot_status_history.lot_id
        AND l.operator_id = current_operator_id()
    )
  );

-- lot_status_history: bidder sees history for lots they have invoices for
DROP POLICY IF EXISTS lot_status_history_bidder_read ON lot_status_history;
CREATE POLICY lot_status_history_bidder_read ON lot_status_history
  FOR SELECT TO authenticated
  USING (
    is_bidder() AND EXISTS (
      SELECT 1
      FROM invoice_lots il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE il.lot_id = lot_status_history.lot_id
        AND i.bidder_id = auth.uid()
    )
  );

-- auction_status_history: operator staff
DROP POLICY IF EXISTS auction_status_history_operator_read ON auction_status_history;
CREATE POLICY auction_status_history_operator_read ON auction_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM auctions a
      WHERE a.id = auction_status_history.auction_id
        AND a.operator_id = current_operator_id()
    )
  );

-- auction_status_history: bidder sees published-auction history
DROP POLICY IF EXISTS auction_status_history_bidder_read ON auction_status_history;
CREATE POLICY auction_status_history_bidder_read ON auction_status_history
  FOR SELECT TO authenticated
  USING (
    is_bidder() AND EXISTS (
      SELECT 1 FROM auctions a
      WHERE a.id = auction_status_history.auction_id
        AND a.status IN ('scheduled', 'live', 'closed')
    )
  );

-- invoice_status_history: operator staff
DROP POLICY IF EXISTS invoice_status_history_operator_read ON invoice_status_history;
CREATE POLICY invoice_status_history_operator_read ON invoice_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_status_history.invoice_id
        AND i.operator_id = current_operator_id()
    )
  );

-- invoice_status_history: bidder reads own invoices' history
DROP POLICY IF EXISTS invoice_status_history_bidder_read ON invoice_status_history;
CREATE POLICY invoice_status_history_bidder_read ON invoice_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_status_history.invoice_id
        AND i.bidder_id = auth.uid()
    )
  );

-- All three tables are append-only — no INSERT/UPDATE/DELETE from
-- authenticated roles. The triggers run as SECURITY DEFINER and bypass
-- RLS to write. No explicit grants needed; RLS denies by default.

-- ---------------------------------------------------------------------------
-- 5. Convenience views — single timeline per entity
-- ---------------------------------------------------------------------------
-- These aren't strictly necessary (callers can SELECT directly from the
-- history tables) but they shape the data for a "timeline" UI without
-- the app code having to join+order+normalize.

CREATE OR REPLACE VIEW lot_timeline AS
SELECT
  lot_id,
  changed_at,
  changed_by,
  CASE
    WHEN from_status IS NULL THEN 'created'
    WHEN to_status = 'canceled' THEN 'canceled'
    WHEN to_status = 'won' THEN 'won'
    WHEN to_status = 'unsold' THEN 'unsold'
    WHEN to_status = 'relisted' THEN 'relisted'
    WHEN to_status = 'live' THEN 'went_live'
    WHEN to_status = 'scheduled' THEN 'scheduled'
    WHEN to_status = 'in_inventory' THEN 'binned'
    ELSE 'status_change'
  END AS event_label,
  from_status,
  to_status,
  context
FROM lot_status_history
ORDER BY lot_id, changed_at DESC;

GRANT SELECT ON lot_timeline TO authenticated;

CREATE OR REPLACE VIEW auction_timeline AS
SELECT
  auction_id,
  changed_at,
  changed_by,
  CASE
    WHEN from_status IS NULL THEN 'created'
    WHEN to_status = 'canceled' THEN 'canceled'
    WHEN to_status = 'closed' THEN 'closed'
    WHEN to_status = 'live' THEN 'went_live'
    WHEN to_status = 'scheduled' THEN 'scheduled'
    ELSE 'status_change'
  END AS event_label,
  from_status,
  to_status,
  context
FROM auction_status_history
ORDER BY auction_id, changed_at DESC;

GRANT SELECT ON auction_timeline TO authenticated;

CREATE OR REPLACE VIEW invoice_timeline AS
SELECT
  invoice_id,
  changed_at,
  changed_by,
  CASE
    WHEN from_status IS NULL THEN 'created'
    WHEN to_status = 'paid' THEN 'paid'
    WHEN to_status = 'refunded' THEN 'refunded'
    WHEN to_status = 'partially_refunded' THEN 'partially_refunded'
    WHEN to_status = 'canceled' THEN 'canceled'
    ELSE 'status_change'
  END AS event_label,
  from_status,
  to_status,
  context
FROM invoice_status_history
ORDER BY invoice_id, changed_at DESC;

GRANT SELECT ON invoice_timeline TO authenticated;

COMMIT;
