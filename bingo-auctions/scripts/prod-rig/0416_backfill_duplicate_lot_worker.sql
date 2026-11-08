-- 0416 backfill — credit past Duplicate Lot copies to the worker of the lot
-- they were copied from. WRITTEN, NOT RUN. Run by hand after 0416 is applied.
--
-- Why: before 0416 duplicate_lot never copied lotted_by_worker and the app
-- sent no worker, so every copy was credited to nobody (Oct 13 Crandall: 42 of
-- 108 lots unattributed, ~40 of them copies of a Tim or Lane lot).
--
-- ── HOW A COPY IS LINKED TO ITS SOURCE ───────────────────────────────────────
-- It is not, in the schema. duplicate_lot deliberately records no lineage
-- (0299: relisted_from_lot_id stays NULL so a case of identical boxes is not
-- read as relists of one box), writes no audit row, and lot_status_history
-- only records the copy's own initial status. So the source is MATCHED:
--
--   the copy  : lotted_by_worker IS NULL, not deleted, and carries the
--               duplicate_lot signature — relisted_from_lot_id, import_row_id
--               and client_dedup_token all NULL (duplicate_lot never sets
--               them; app create-draft sets client_dedup_token, relists set
--               relisted_from_lot_id, manifest lots set import_row_id) — and
--               at least one photo;
--   the source: same operator, same lotted_by login, same title, the SAME
--               photo_urls array (a copy shares its source's uploaded photo
--               URLs; separately lotted boxes get their own uploads),
--               lotted_by_worker NOT NULL, created up to 10 minutes BEFORE
--               the copy. The nearest such source wins. Copies made before
--               duplicate_lot existed (0299, 2026-07-29) are impossible and
--               excluded.
--
-- Why 10 minutes, not 2 (measured read-only on prod, 2026-10-14):
--   window       Oct 13 Crandall (of 42 unattributed)   all time
--   2 min                 34                              1,377
--   10 min                42                              2,131
--   any gap               42                              3,807
-- 2 minutes misses 8 of the Oct 13 copies (staff duplicate the same lot
-- several times in a row, so later copies sit minutes after the source).
-- Beyond 10 minutes the tail is long (to days) and the nearest attributed twin
-- is less likely to be the person holding the box, so it is left unfilled.
-- 159 of the 2,131 share retailer catalog photos (target/walmart/lowes/...)
-- rather than our own uploads; same login + title + photos within 10 minutes
-- still reads as a copy, so they are included.
--
-- Written with window functions, not a per-row LATERAL: the LATERAL form hit
-- the statement timeout as a read-only prod query (no index on title).
--
-- SCOPE: Oct 13 2026 (Chicago day) ONLY, per Braden 2026-10-14. The all-time
-- numbers above are for reference; widening the scope needs his go.
--
-- Only NULL workers are filled; nothing already attributed is touched.
-- Row locks on the matched lots only, no table lock. Lots are written all day
-- by staff — Rule 9: run 05:00–07:00 or after 18:00 CT.

-- ── 1. DRY RUN (read-only) ───────────────────────────────────────────────────
-- The UPDATE below must touch exactly oct13_all (expect oct13_crandall = 42).
WITH p AS (
  SELECT l.id, l.operator_id, l.lotted_by, l.title, l.photo_urls, l.created_at,
         l.warehouse_id, l.lotted_by_worker, l.deleted_at,
         l.relisted_from_lot_id, l.import_row_id, l.client_dedup_token,
         -- running count of attributed lots in this (login, title, photos)
         -- group: an unattributed row shares its grp with the nearest
         -- attributed row at or before it.
         count(l.lotted_by_worker) OVER (
           PARTITION BY l.operator_id, l.lotted_by, l.title, l.photo_urls
           ORDER BY l.created_at, l.id) AS grp
    FROM lots l
), q AS (
  SELECT p.*,
         max(p.lotted_by_worker::text) OVER g AS src_worker,
         max(CASE WHEN p.lotted_by_worker IS NOT NULL THEN p.created_at END) OVER g AS src_at
    FROM p
  WINDOW g AS (PARTITION BY p.operator_id, p.lotted_by, p.title, p.photo_urls, p.grp)
), m AS (
  SELECT q.id, q.warehouse_id, q.created_at, q.src_worker::uuid AS worker_id,
         q.created_at - q.src_at AS gap
    FROM q
   WHERE q.lotted_by_worker IS NULL
     AND q.deleted_at IS NULL
     AND q.relisted_from_lot_id IS NULL
     AND q.import_row_id IS NULL
     AND q.client_dedup_token IS NULL
     AND coalesce(array_length(q.photo_urls, 1), 0) > 0
     AND (q.created_at AT TIME ZONE 'America/Chicago')::date = date '2026-10-13'  -- Oct 13 only (Braden, 2026-10-14)
     AND q.src_at IS NOT NULL
     AND q.created_at >  q.src_at
     AND q.created_at <= q.src_at + interval '10 minutes'
)
SELECT
  count(*) FILTER (
    WHERE (m.created_at AT TIME ZONE 'America/Chicago')::date = date '2026-10-13'
      AND m.warehouse_id IN (SELECT id FROM warehouses WHERE name ILIKE '%crandall%')
  )                 AS oct13_crandall,
  count(*)          AS oct13_all,
  min(m.created_at) AS earliest,
  max(m.created_at) AS latest,
  max(m.gap)        AS max_gap
FROM m;

-- ── 2. APPLY (one transaction; check the count before COMMIT) ────────────────
BEGIN;

WITH p AS (
  SELECT l.id, l.operator_id, l.lotted_by, l.title, l.photo_urls, l.created_at,
         l.lotted_by_worker, l.deleted_at,
         l.relisted_from_lot_id, l.import_row_id, l.client_dedup_token,
         count(l.lotted_by_worker) OVER (
           PARTITION BY l.operator_id, l.lotted_by, l.title, l.photo_urls
           ORDER BY l.created_at, l.id) AS grp
    FROM lots l
), q AS (
  SELECT p.*,
         max(p.lotted_by_worker::text) OVER g AS src_worker,
         max(CASE WHEN p.lotted_by_worker IS NOT NULL THEN p.created_at END) OVER g AS src_at
    FROM p
  WINDOW g AS (PARTITION BY p.operator_id, p.lotted_by, p.title, p.photo_urls, p.grp)
), m AS (
  SELECT q.id, q.src_worker::uuid AS worker_id
    FROM q
   WHERE q.lotted_by_worker IS NULL
     AND q.deleted_at IS NULL
     AND q.relisted_from_lot_id IS NULL
     AND q.import_row_id IS NULL
     AND q.client_dedup_token IS NULL
     AND coalesce(array_length(q.photo_urls, 1), 0) > 0
     AND (q.created_at AT TIME ZONE 'America/Chicago')::date = date '2026-10-13'  -- Oct 13 only (Braden, 2026-10-14)
     AND q.src_at IS NOT NULL
     AND q.created_at >  q.src_at
     AND q.created_at <= q.src_at + interval '10 minutes'
)
UPDATE lots l
   SET lotted_by_worker = m.worker_id
  FROM m
 WHERE l.id = m.id
   AND l.lotted_by_worker IS NULL;   -- first writer wins (0321)

-- psql prints UPDATE <n>. It must equal oct13_all from the dry run.
-- Equal → COMMIT;  anything else → ROLLBACK;
-- COMMIT;
