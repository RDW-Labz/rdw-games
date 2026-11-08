-- ============================================================================
-- 0135_db_tuning_p1 — DB P1 audit fixes (2026-05-24)
--
-- DB-7  competitor_lots storage tuning: fillfactor + EXTERNAL raw_json
-- DB-8  bulk_assign_lot_numbers() helper — replaces N sequential UPDATEs
-- DB-9  (no SQL change — LOT_ROW_CAP + .limit() applied in TS layer)
-- DB-10 RLS tightening: _schema_migrations → service-role only
--        competitor_lots RLS: document deliberate anon-auth read choice
-- ============================================================================

-- ============================================================================
-- DB-7 — competitor_lots storage tuning
--
-- At 5 MM rows, raw_json (full scraper response) can be many KB per row.
-- Without EXTERNAL storage Postgres inlines small JSONs and TOAST-compresses
-- larger ones, causing TOAST table bloat on the update-heavy scraper writes.
--
-- EXTERNAL:   forces out-of-line storage WITHOUT compression.
--             Reads that need raw_json skip decompression (faster);
--             rows that don't need raw_json skip the TOAST fetch entirely
--             (the heap page just holds a pointer). Best for forensic/rarely-
--             read columns at high cardinality.
--
-- fillfactor=70: leaves 30% of each heap page free for HOT updates.
--             The scraper does frequent last_seen_at / current_bid_cents
--             updates — HOT lets those land on the same page without a new
--             heap tuple, cutting index bloat and vacuum load significantly.
--             70 is the conventional starting point for write-heavy tables;
--             adjust toward 80 if read-heavy periods dominate.
-- ============================================================================

ALTER TABLE competitor_lots SET (fillfactor=70);
ALTER TABLE competitor_lots ALTER COLUMN raw_json SET STORAGE EXTERNAL;

-- ============================================================================
-- DB-8 — bulk_assign_lot_numbers(uuid[], uuid, int, text, timestamptz)
--
-- Replaces the N-round-trip loop in assignLotsToAuction (inventory/actions.ts).
-- The TS caller already calls reserve_lot_number_range() to get firstLotNumber,
-- then loops N times issuing individual UPDATEs. This function accepts the same
-- inputs and executes a single UPDATE with unnest+ordinality to assign
-- sequential lot_numbers in one shot.
--
-- Parameters:
--   p_lot_ids       — ordered array; lot_numbers assigned left-to-right
--   p_auction_id    — target auction
--   p_first_number  — first lot_number (from reserve_lot_number_range)
--   p_status        — 'scheduled' | 'draft'
--   p_close_at      — lots.close_at value (auction's ends_at)
--   p_operator_id   — RLS double-check; UPDATE only touches this operator's lots
--
-- Returns: count of rows actually updated (< array length if any ids were
-- not found or didn't match operator_id; caller surfaces this as failures).
--
-- Security: SECURITY DEFINER so it can bypass RLS for the bulk write while
-- still enforcing the operator_id guard inline. Caller must be authenticated
-- (enforced by GRANT below).
-- ============================================================================

CREATE OR REPLACE FUNCTION bulk_assign_lot_numbers(
  p_lot_ids      UUID[],
  p_auction_id   UUID,
  p_first_number INT,
  p_status       TEXT,
  p_close_at     TIMESTAMPTZ,
  p_operator_id  UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  WITH numbered AS (
    SELECT
      id::UUID   AS lot_id,
      (p_first_number + (ordinality - 1)::INT) AS lot_num
    FROM unnest(p_lot_ids) WITH ORDINALITY AS t(id, ordinality)
  )
  UPDATE lots l
  SET
    auction_id  = p_auction_id,
    lot_number  = n.lot_num,
    status      = p_status,
    close_at    = p_close_at
  FROM numbered n
  WHERE l.id = n.lot_id
    AND l.operator_id = p_operator_id
    AND l.status = 'in_inventory'
    AND l.auction_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION bulk_assign_lot_numbers(UUID[], UUID, INT, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bulk_assign_lot_numbers(UUID[], UUID, INT, TEXT, TIMESTAMPTZ, UUID) TO authenticated;

-- ============================================================================
-- DB-10 — RLS policy tightening
--
-- A. _schema_migrations — migration history table.
--    0033 set: FOR SELECT USING (auth.uid() IS NOT NULL)
--    Problem: any logged-in bidder or staff member can enumerate every
--    migration filename + timestamp. Migration filenames reveal schema
--    structure to any authenticated attacker.
--    Fix: service-role only. The service-role key bypasses RLS entirely,
--    so no explicit policy is needed for writes. The SELECT policy for
--    authenticated users is dropped and not replaced — only service-role
--    can read this table.
--
-- B. competitor_lots — public scrape data from BidFTA / MAC.BID / Nellis.
--    0037 set: FOR SELECT USING (auth.uid() IS NOT NULL)
--    Decision: INTENTIONALLY KEPT as authenticated-read.
--    Rationale:
--      • This is scrape data of publicly-available competitor auction
--        listings. There is no PII, no proprietary data, and no GDPR/CCPA
--        concern. The source URLs are themselves public.
--      • The platform uses this data to show price comps to bidders and
--        trend analytics to operators — both require authenticated reads.
--      • Making it anon-readable would add no meaningful security benefit
--        since the underlying data is already public, but it would open the
--        table to unauthenticated bulk scraping of our derived dataset.
--      • Keeping the auth.uid() IS NOT NULL gate ensures only registered
--        platform users (bidders + staff) can query it, which is the
--        correct access tier.
--    Action: drop + recreate the policy with an explicit comment preserved
--    in the policy name and a SQL comment block for future auditors.
-- ============================================================================

-- ── A. _schema_migrations: drop authed-read; service-role inherits bypass ──

DROP POLICY IF EXISTS schema_migrations_authed_read ON _schema_migrations;
-- No replacement SELECT policy: only the service-role key (which bypasses RLS)
-- may read _schema_migrations. Authenticated users — bidders or staff — have
-- no legitimate reason to enumerate migration history.

-- ── B. competitor_lots: keep authenticated-read, document the choice ─────────

-- Drop the existing policy so we can recreate it with the documented intent.
DROP POLICY IF EXISTS competitor_lots_authed_read ON competitor_lots;

-- DELIBERATE CHOICE: competitor_lots is publicly-scraped data from competitor
-- auction platforms (BidFTA, MAC.BID, Nellis, etc.). There is no PII and no
-- proprietary content. Authenticated-read (any logged-in bidder or staff) is
-- the correct access tier:
--   • Bidders use it for price-comp lookups.
--   • Staff use it for trend analytics and starting-bid recommendations.
--   • Anon access would enable unauthenticated bulk harvesting of the
--     platform's derived/normalized dataset — not desirable.
-- If competitor_lots ever stores any PII (e.g. seller names), revisit this
-- policy and tighten to operator-staff only.
CREATE POLICY competitor_lots_authed_read ON competitor_lots
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- No INSERT/UPDATE/DELETE policy for authenticated users.
-- The scraper runs server-side with the service-role key, which bypasses RLS.

-- ============================================================================
-- Self-mark
-- ============================================================================

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0135_db_tuning_p1.sql', 'migration:0135')
ON CONFLICT (filename) DO NOTHING;
