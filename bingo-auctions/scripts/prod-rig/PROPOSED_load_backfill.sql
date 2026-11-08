-- PROPOSED — NOT A MIGRATION, NOT APPLIED. Load backfill for existing lots.
-- Needs Braden's go and a migration number before it moves to
-- packages/db/migrations. Run 0428 first (so new lots are already linked).
--
-- Dry-run on prod 2026-10-20 (read-only, docs/... in PR): 16,912 lots would
-- change; 40,919 lots have no load today.
--   manifest      6,152 originals + 1,509 relist copies = 7,661 lots, 19 loads
--   source_name   8,354 originals +   897 relist copies = 9,251 lots, 14 loads
--   skipped names shared by >1 load: wayfair-d2l (103), crandall (2),
--   21358222(manifest).csv (2) — those lots stay unlinked for a person to place.
--
-- Rules
--   A. manifest: a lot named on import_rows.lot_id takes that import's load.
--   B. source_name: an ORIGINAL lot (no relisted_from_lot_id) whose free-text
--      lots.source equals (trimmed, case-insensitive) the name of exactly ONE
--      unarchived load of the operator takes that load. A wins over B.
--   Both: every relist copy below that lot (relisted_from_lot_id chain) takes
--   the same load. Only lots with load_id IS NULL are touched; nothing is
--   overwritten.
--
-- Exact rollback: one operator_audit_log row per load, action_type
-- 'load.backfill', target_id = load id, after_state.lot_ids = every lot set.
-- scripts/prod-rig/PROPOSED_load_backfill_ROLLBACK.sql clears exactly those
-- ids, and only where load_id still equals that load.
--
-- Locks: row UPDATEs on lots (~17k rows, one statement). Rule 9: 05:00–07:00 CT.

BEGIN;

CREATE TEMP TABLE _load_backfill ON COMMIT DROP AS
WITH RECURSIVE op AS (SELECT id FROM operators WHERE slug = 'bingo-auctions'),
ld AS (SELECT loads.* FROM loads, op WHERE loads.operator_id = op.id),
uniq AS (
  SELECT lower(btrim(source_name)) AS nm, min(id::text)::uuid AS load_id
    FROM ld WHERE archived_at IS NULL
   GROUP BY 1 HAVING count(*) = 1
),
a_seed AS (
  SELECT DISTINCT ON (ir.lot_id) ir.lot_id, l2.id AS load_id
    FROM import_rows ir
    JOIN lots l  ON l.id = ir.lot_id
    JOIN ld   l2 ON l2.import_id = ir.import_id
    JOIN op      ON l.operator_id = op.id
   WHERE l.deleted_at IS NULL AND l.load_id IS NULL
   ORDER BY ir.lot_id, ir.lotted_at DESC NULLS LAST
),
b_seed AS (
  SELECT l.id AS lot_id, u.load_id
    FROM lots l
    JOIN op   ON l.operator_id = op.id
    JOIN uniq u ON u.nm = lower(btrim(l.source))
   WHERE l.deleted_at IS NULL AND l.load_id IS NULL AND l.relisted_from_lot_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM a_seed a WHERE a.lot_id = l.id)
),
seed AS (
  SELECT lot_id, load_id, 'manifest'::text AS m FROM a_seed
  UNION ALL
  SELECT lot_id, load_id, 'source_name' FROM b_seed
),
tree AS (
  SELECT lot_id, load_id, m, 0 AS d FROM seed
  UNION ALL
  SELECT c.id, t.load_id, t.m, t.d + 1
    FROM lots c JOIN tree t ON c.relisted_from_lot_id = t.lot_id
   WHERE t.d < 20 AND c.deleted_at IS NULL AND c.load_id IS NULL
)
SELECT DISTINCT ON (lot_id) lot_id, load_id, m
  FROM tree
 ORDER BY lot_id, CASE m WHEN 'manifest' THEN 0 ELSE 1 END, d;

-- Log first (same transaction), so the rollback list always exists.
INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
SELECT ld.operator_id, NULL, 'load.backfill', b.load_id, NULL,
       jsonb_build_object('lot_ids', jsonb_agg(b.lot_id ORDER BY b.lot_id), 'count', count(*),
                          'methods', jsonb_agg(DISTINCT b.m)),
       'Load backfill (PROPOSED_load_backfill.sql): lots linked to this load'
  FROM _load_backfill b JOIN loads ld ON ld.id = b.load_id
 GROUP BY ld.operator_id, b.load_id;

UPDATE lots l
   SET load_id = b.load_id
  FROM _load_backfill b
 WHERE l.id = b.lot_id
   AND l.load_id IS NULL;

DO $$
DECLARE v_n int; v_logged int;
BEGIN
  SELECT count(*) INTO v_n FROM _load_backfill;
  SELECT coalesce(sum((after_state->>'count')::int), 0) INTO v_logged
    FROM operator_audit_log WHERE action_type = 'load.backfill' AND created_at = now();
  RAISE NOTICE 'load backfill: % lots linked, % logged', v_n, v_logged;
  IF v_n <> v_logged THEN
    RAISE EXCEPTION 'load backfill: logged % but linked % — rolling back', v_logged, v_n;
  END IF;
END
$$;

COMMIT;
