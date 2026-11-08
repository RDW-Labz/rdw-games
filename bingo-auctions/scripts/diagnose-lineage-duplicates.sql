-- Diagnose the 2026-07-28 P0: assign_lots_to_auction raises
-- `lot_item_already_listed` for items the operator says are distinct goods.
--
-- The question this answers, and why it decides the fix:
--
--   `relist_lot_into_auction` (0192 STEP 1/2, carried into 0285) NULLs the
--   source's sticker_code and MOVES it onto the new child. So:
--
--     • two siblings minted by sequential relists of ONE parent  ->  the
--       sticker sits on exactly one of them, the other is NULL. They are the
--       SAME physical box. The guard is CORRECT and must stay.
--
--     • two boxes each stickered independently at intake  ->  each holds its
--       OWN non-null sticker_code (globally unique via 0141
--       lots_sticker_code_unique_idx). They are DISTINCT goods. The guard is
--       wrong to block them.
--
--   So: does each member of a failing pair hold its own sticker_code?
--
-- Run against prod npwseclcxcatjhgjrtwe. Read-only.

-- ---------------------------------------------------------------------------
-- Q1. The five reported pairs: lineage shape + physical identity.
--
-- Read `relation`:
--   direct_line -> one is an ancestor of the other. SAME item, always.
--                  Guard is right; this is not a regression.
--   collateral  -> siblings/cousins. Then read sticker_state:
--                  both_stickered -> distinct goods, guard is wrong.
--                  otherwise      -> unprovable, most likely the same box.
-- ---------------------------------------------------------------------------
WITH RECURSIVE target AS (
  SELECT id, lot_code, title, status, sticker_code, qr_token,
         relisted_from_lot_id, relist_count, created_at, source, external_code
  FROM lots
  WHERE lot_code IN (
    'BIN-002437','BIN-002569',   -- Napoles utility sink
    'BIN-002565','BIN-002622',   -- Heiki loft bed (INCOMPLETE)
    'BIN-002567','BIN-002624',   -- Kylan nail desk
    'BIN-002571','BIN-002629',   -- Tevrat 5-drawer dresser
    'BIN-002570','BIN-002627'    -- Nesting side table set
  )
),
-- Ancestors of each target (self first, then up the relisted_from_lot_id chain).
up AS (
  SELECT t.id AS target_id, t.id AS cur, t.relisted_from_lot_id AS parent_id, 0 AS depth
  FROM target t
  UNION ALL
  SELECT u.target_id, p.id, p.relisted_from_lot_id, u.depth + 1
  FROM up u JOIN lots p ON p.id = u.parent_id
),
roots AS (
  SELECT target_id, cur AS root_id FROM up WHERE parent_id IS NULL
),
ancestors AS (
  SELECT target_id, cur AS ancestor_id FROM up WHERE depth > 0
)
SELECT
  t.title,
  t.lot_code,
  t.status,
  t.relist_count,
  r.root_id,
  rl.lot_code AS root_lot_code,
  -- physical identity: is there a sticker on THIS row?
  (t.sticker_code IS NOT NULL) AS has_sticker,
  t.sticker_code,
  -- how this lot relates to the OTHER target sharing its root
  CASE
    WHEN EXISTS (
      SELECT 1 FROM ancestors a
       WHERE a.target_id = t.id
         AND a.ancestor_id IN (SELECT id FROM target WHERE id <> t.id)
    ) OR EXISTS (
      SELECT 1 FROM ancestors a2
       WHERE a2.ancestor_id = t.id
         AND a2.target_id IN (SELECT id FROM target WHERE id <> t.id)
    ) THEN 'direct_line'
    ELSE 'collateral'
  END AS relation,
  t.source,
  t.external_code,
  t.created_at
FROM target t
JOIN roots r  ON r.target_id = t.id
JOIN lots rl  ON rl.id = r.root_id
ORDER BY r.root_id, t.created_at;

-- ---------------------------------------------------------------------------
-- Q2. Per-root verdict — the single table that decides the fix.
--
-- both_stickered on a collateral pair  => distinct goods, relax the guard.
-- anything else                        => same box, guard stays, Jared needs
--                                         the "N identical items" feature
--                                         instead of a guard change.
-- ---------------------------------------------------------------------------
WITH RECURSIVE target AS (
  SELECT id, lot_code, title, sticker_code, relisted_from_lot_id
  FROM lots
  WHERE lot_code IN (
    'BIN-002437','BIN-002569','BIN-002565','BIN-002622','BIN-002567',
    'BIN-002624','BIN-002571','BIN-002629','BIN-002570','BIN-002627'
  )
),
up AS (
  SELECT t.id AS target_id, t.id AS cur, t.relisted_from_lot_id AS parent_id
  FROM target t
  UNION ALL
  SELECT u.target_id, p.id, p.relisted_from_lot_id
  FROM up u JOIN lots p ON p.id = u.parent_id
),
roots AS (SELECT target_id, cur AS root_id FROM up WHERE parent_id IS NULL)
SELECT
  r.root_id,
  min(t.title)                                          AS title,
  count(*)                                              AS n_lots,
  array_agg(t.lot_code ORDER BY t.lot_code)             AS lot_codes,
  count(*) FILTER (WHERE t.sticker_code IS NOT NULL)    AS n_with_sticker,
  CASE
    WHEN count(*) FILTER (WHERE t.sticker_code IS NOT NULL) = count(*)
      THEN 'both_stickered -> DISTINCT GOODS (relax guard)'
    WHEN count(*) FILTER (WHERE t.sticker_code IS NOT NULL) = 0
      THEN 'none_stickered -> unprovable (guard stays)'
    ELSE 'one_stickered -> relist twin, SAME box (guard is correct)'
  END AS verdict
FROM target t
JOIN roots r ON r.target_id = t.id
GROUP BY r.root_id
ORDER BY r.root_id;

-- ---------------------------------------------------------------------------
-- Q3. Scale check — how much of the operator's live inventory is affected?
--     Counts every in_inventory lot that assign_lots_to_auction would refuse
--     today, split by whether the block is defensible.
-- ---------------------------------------------------------------------------
WITH RECURSIVE assignable AS (
  SELECT id, lot_code, sticker_code, relisted_from_lot_id, warehouse_id, title
  FROM lots
  WHERE deleted_at IS NULL
    AND status = 'in_inventory'
    AND auction_id IS NULL
    AND relisted_from_lot_id IS NOT NULL
),
up AS (
  SELECT a.id AS target_id, a.id AS cur, a.relisted_from_lot_id AS parent_id, 0 AS depth
  FROM assignable a
  UNION ALL
  SELECT u.target_id, p.id, p.relisted_from_lot_id, u.depth + 1
  FROM up u JOIN lots p ON p.id = u.parent_id
),
roots AS (SELECT target_id, cur AS root_id FROM up WHERE parent_id IS NULL),
ancestors AS (SELECT target_id, cur AS ancestor_id FROM up WHERE depth > 0),
-- every active lot, with its root
active_up AS (
  SELECT l.id AS active_id, l.id AS cur, l.relisted_from_lot_id AS parent_id
  FROM lots l
  WHERE l.deleted_at IS NULL AND l.status IN ('scheduled','live')
  UNION ALL
  SELECT au.active_id, p.id, p.relisted_from_lot_id
  FROM active_up au JOIN lots p ON p.id = au.parent_id
),
active_roots AS (SELECT active_id, cur AS root_id FROM active_up WHERE parent_id IS NULL),
blocked AS (
  SELECT
    a.id, a.lot_code, a.title, a.sticker_code,
    act.id AS other_id, act.lot_code AS other_code, act.sticker_code AS other_sticker,
    (a.id IN (SELECT target_id FROM ancestors WHERE ancestor_id = act.id)
     OR act.id IN (SELECT ancestor_id FROM ancestors WHERE target_id = a.id)) AS direct_line
  FROM assignable a
  JOIN roots r        ON r.target_id = a.id
  JOIN active_roots ar ON ar.root_id = r.root_id
  JOIN lots act        ON act.id = ar.active_id
)
SELECT
  CASE
    WHEN direct_line THEN 'blocked_direct_line (correct — same item)'
    WHEN sticker_code IS NOT NULL AND other_sticker IS NOT NULL
      THEN 'blocked_but_distinct (THE REGRESSION — both stickered)'
    ELSE 'blocked_collateral_unprovable'
  END AS classification,
  count(DISTINCT id) AS n_lots
FROM blocked
GROUP BY 1
ORDER BY 2 DESC;
