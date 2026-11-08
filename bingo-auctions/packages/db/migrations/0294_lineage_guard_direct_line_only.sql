-- 0294 — the one-active-lot guard blocked SIBLINGS, not just the same item
--
-- Incident 2026-07-28: ~95% of Jared's duplicate items refused to post to an
-- auction with `lot_item_already_listed`, even on different lot codes. 0288's
-- guard resolves a lot's lineage ROOT, walks the ENTIRE tree, and refuses if any
-- other member is scheduled/live. That is too broad: a tree contains collateral
-- relatives (siblings, cousins), and a sibling is not necessarily the same box.
--
-- ── What identifies a physical item here ───────────────────────────────────
--
-- NOT lineage, and NOT "two lots sharing a sticker" either — `sticker_code`
-- (0141, partial UNIQUE on NOT NULL) and `qr_token` (0103, UNIQUE) are already
-- GLOBALLY unique, so two lots can never share a value and a shared-sticker
-- check could never fire.
--
-- What is load-bearing is that `relist_lot_into_auction` (0192 STEP 1/2, carried
-- verbatim into 0285) NULLs the source's `sticker_code` and MOVES it onto the new
-- child. A second relist of the same parent finds no sticker left to move, so
-- its child is inserted with NULL. Therefore, within one lineage:
--
--   • two siblings minted by sequential relists of ONE parent
--       -> the sticker sits on exactly ONE of them, the other is NULL.
--          SAME physical box. Must stay blocked.
--
--   • two boxes each stickered independently at intake
--       -> each holds its OWN non-null sticker_code.
--          DISTINCT goods. Must be allowed.
--
-- One physical box carries one sticker, so "both sides hold their own sticker"
-- is a PROOF of distinctness, not a heuristic.
--
-- ── The rule ───────────────────────────────────────────────────────────────
--
--   Refuse if the active relative is an ANCESTOR or DESCENDANT (direct line) —
--   same item by construction, and this is the shape 0288 was actually built to
--   stop ("a retired ancestor re-assigned alongside its still-active
--   descendant").
--
--   For COLLATERAL relatives, refuse only when distinctness is UNPROVABLE, i.e.
--   either side lacks a sticker. Two independently-stickered boxes pass.
--
-- This is a STRICT RELAXATION of 0288: every assignment 0288 permitted is still
-- permitted, and nothing 0288 blocked as a genuine same-item duplicate becomes
-- allowed. It cannot re-open the hole 0290 closed (3 phantom lots taking bids on
-- stock already paid for and collected) — those were direct-line, and the
-- `sold_and_collected_still_live` audit check still covers the class.
--
-- Deliberately NOT changed:
--   • `relist_lot_into_auction` D1 (0285). It refuses when the SOURCE has an
--     active child — a parent/child pair, which is direct line, so it is already
--     correct under this rule. It does still key on `canceled_at` rather than
--     `status`, which 0290 fixed for the index but not for D1; that asymmetry is
--     real but is a separate defect and is left for its own change.
--   • The `lot_lineage_root` / `lot_lineage_members` helpers from 0288 — still
--     used, and still correct for what they claim.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. lot_lineage_chain — the DIRECT LINE through a lot: its ancestors, itself,
--    and its descendants. Deliberately excludes collateral relatives, which is
--    the whole point of this migration. Contrast lot_lineage_members(root),
--    which returns the entire tree including siblings and cousins.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lot_lineage_chain(p_lot_id UUID)
RETURNS TABLE (lot_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE up AS (
    -- self, then strictly upward via relisted_from_lot_id
    SELECT l.id, l.relisted_from_lot_id
    FROM lots l WHERE l.id = p_lot_id
    UNION ALL
    SELECT p.id, p.relisted_from_lot_id
    FROM up JOIN lots p ON p.id = up.relisted_from_lot_id
  ),
  down AS (
    -- self, then strictly downward
    SELECT l.id FROM lots l WHERE l.id = p_lot_id
    UNION ALL
    SELECT c.id FROM lots c JOIN down ON c.relisted_from_lot_id = down.id
  )
  SELECT id FROM up
  UNION
  SELECT id FROM down;
$$;

COMMENT ON FUNCTION public.lot_lineage_chain(UUID) IS
  '0294: the direct line through a lot — ancestors + self + descendants, and '
  'NOTHING collateral. Every member is provably the same physical item as the '
  'input, because a relist carries one box forward. Use this, not '
  'lot_lineage_members(lot_lineage_root(x)), for same-item tests: the tree '
  'contains siblings, which may be genuinely different goods.';

-- ---------------------------------------------------------------------------
-- 2. assign_lots_to_auction — 0288 verbatim, with the guard narrowed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_lots_to_auction(
  p_auction_id UUID,
  p_lot_ids UUID[]
)
RETURNS TABLE(lot_id UUID, lot_code TEXT, lot_number INTEGER, close_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_caller       UUID := auth.uid();
  v_operator_id  UUID;
  v_role         operator_user_role;
  v_auction      RECORD;
  v_stagger      INTEGER;
  v_ends_at      TIMESTAMPTZ;
  v_next_number  INTEGER;
  v_lot          RECORD;
  v_close_at     TIMESTAMPTZ;
  -- 0288: conflicting active listing for the same physical item, if any.
  v_dup_code     TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT operator_id, role INTO v_operator_id, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_operator_id IS NULL THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;

  -- Auction must belong to the operator and accept new lots.
  SELECT a.id, a.ends_at, a.warehouse_id, a.status, a.close_stagger_seconds
    INTO v_auction
  FROM auctions a
  WHERE a.id = p_auction_id AND a.operator_id = v_operator_id
  FOR UPDATE;

  IF v_auction.id IS NULL THEN
    RAISE EXCEPTION 'auction_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'auction_not_editable_status:%', v_auction.status
      USING ERRCODE = '42501';
  END IF;

  v_stagger := COALESCE(v_auction.close_stagger_seconds, 0);
  v_ends_at := v_auction.ends_at;

  SELECT COALESCE(MAX(l.lot_number), 0) + 1 INTO v_next_number
  FROM lots l WHERE l.auction_id = p_auction_id;

  FOR v_lot IN
    -- 0294: sticker_code added — it is the physical-identity signal the guard
    -- below needs.
    SELECT l.id, l.lot_code, l.status, l.warehouse_id, l.auction_id, l.sticker_code
    FROM lots l
    WHERE l.id = ANY(p_lot_ids)
      AND l.operator_id = v_operator_id
    ORDER BY l.id
    FOR UPDATE
  LOOP
    IF v_lot.auction_id IS NOT NULL THEN
      RAISE EXCEPTION 'lot_already_in_auction:%', v_lot.lot_code
        USING ERRCODE = '42501';
    END IF;
    IF v_lot.status <> 'in_inventory' THEN
      RAISE EXCEPTION 'lot_not_in_inventory:%:%', v_lot.lot_code, v_lot.status
        USING ERRCODE = '42501';
    END IF;
    IF v_auction.warehouse_id IS NOT NULL
       AND v_lot.warehouse_id <> v_auction.warehouse_id THEN
      RAISE EXCEPTION 'lot_wrong_warehouse:%', v_lot.lot_code
        USING ERRCODE = '42501';
    END IF;

    -- 0294 (a): DIRECT LINE. An ancestor or descendant that is scheduled/live is
    -- the same box as this lot — a relist carries one physical item forward — so
    -- this is an unconditional refusal. This is the shape every duplicate pair
    -- 0288 investigated actually had.
    SELECT other.lot_code INTO v_dup_code
      FROM lots other
     WHERE other.id IN (SELECT c.lot_id FROM lot_lineage_chain(v_lot.id) c)
       AND other.id <> v_lot.id
       AND other.deleted_at IS NULL
       AND other.status::text IN ('scheduled', 'live')
     LIMIT 1;
    IF v_dup_code IS NOT NULL THEN
      RAISE EXCEPTION 'lot_item_already_listed:%:%', v_lot.lot_code, v_dup_code
        USING ERRCODE = 'P0001';
    END IF;

    -- 0294 (b): COLLATERAL relative (sibling/cousin) that is scheduled/live.
    -- These MAY be different goods, so refuse only when we cannot prove it.
    -- Proof = both sides hold their own sticker_code, which is globally unique,
    -- so two stickers means two boxes. If either side is NULL we cannot tell —
    -- and the NULL side is exactly what a second relist of one parent produces —
    -- so keep 0288's refusal in that case.
    SELECT other.lot_code INTO v_dup_code
      FROM lots other
     WHERE other.id IN (
             SELECT m.lot_id FROM lot_lineage_members(lot_lineage_root(v_lot.id)) m
           )
       AND other.id <> v_lot.id
       AND other.deleted_at IS NULL
       AND other.status::text IN ('scheduled', 'live')
       AND (v_lot.sticker_code IS NULL OR other.sticker_code IS NULL)
     LIMIT 1;
    IF v_dup_code IS NOT NULL THEN
      RAISE EXCEPTION 'lot_item_already_listed:%:%', v_lot.lot_code, v_dup_code
        USING ERRCODE = 'P0001';
    END IF;

    -- mig 0208: clamp to the future so a stale (past) ends_at on a recovered
    -- draft can never produce a past close_at.
    v_close_at := GREATEST(v_ends_at, now())
                  + (make_interval(secs => v_stagger * (v_next_number - 1)));

    UPDATE lots
       SET auction_id = p_auction_id,
           lot_number = v_next_number,
           status     = 'scheduled',
           close_at   = v_close_at
     WHERE id = v_lot.id;

    lot_id     := v_lot.id;
    lot_code   := v_lot.lot_code;
    lot_number := v_next_number;
    close_at   := v_close_at;
    RETURN NEXT;

    v_next_number := v_next_number + 1;
  END LOOP;

  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_lots_to_auction(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_lots_to_auction(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION public.assign_lots_to_auction(UUID, UUID[]) IS
  '0294: 0288 behaviour, but the one-active-lot guard fires on the DIRECT LINE '
  '(ancestor/descendant) unconditionally and on COLLATERAL relatives only when '
  'either side lacks a sticker_code. 0288 walked the whole lineage tree and so '
  'refused two separately-stickered boxes as if they were one item, blocking '
  'legitimate identical goods. Still raises lot_item_already_listed:<lot>:<other>.';

-- ---------------------------------------------------------------------------
-- 3. Re-key lots_one_active_relist_child on the same basis.
--
-- 0290's version is UNIQUE(relisted_from_lot_id) WHERE active — one active child
-- per parent, full stop. Two separately-stickered children of one parent are two
-- boxes, and that index rejects the second one, so relaxing the RPC guard alone
-- would still fail on a 23505.
--
-- Adding `sticker_code IS NULL` makes the index say what we actually mean:
--   • children that carry their own sticker are provably distinct boxes, and
--     lots_sticker_code_unique_idx (0141) already guarantees one lot per sticker
--     globally, so they need no per-parent limit;
--   • children with no sticker are indistinguishable, so at most ONE may be
--     active per parent — which is exactly 0290's guarantee for that population.
--
-- Strictly fewer rows than 0290's predicate, which was verified creatable on
-- prod, so this cannot fail to build where 0290's succeeded.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS lots_one_active_relist_child;

CREATE UNIQUE INDEX lots_one_active_relist_child
  ON public.lots (relisted_from_lot_id)
  WHERE relisted_from_lot_id IS NOT NULL
    AND deleted_at IS NULL
    AND sticker_code IS NULL
    AND status IN ('draft', 'scheduled', 'live');

COMMENT ON INDEX public.lots_one_active_relist_child IS
  '0294 (was 0290, orig 0276): at most one active UNSTICKERED child per parent. '
  'Children holding their own sticker_code are distinct physical boxes — one box '
  'carries one sticker, and sticker_code is globally unique — so they are exempt. '
  'Keyed on status, not canceled_at (see 0290).';

-- ---------------------------------------------------------------------------
-- 4. Teach duplicate_lot_audit() the same distinction.
--
-- Check D (`same_root_active`, added 0290) flags any root with >1 active
-- listing. Under this migration that is no longer a defect on its own, so D
-- would report legitimate rows forever and the "audit returns 0 rows" release
-- gate would become meaningless. D is narrowed to genuine conflicts; a new
-- informational kind reports provably-distinct units so they stay VISIBLE
-- rather than silently dropped from the report.
--
-- Checks A, B, C, E, F, G are reproduced verbatim from 0290.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.duplicate_lot_audit()
RETURNS TABLE (
  kind      TEXT,
  key_value TEXT,
  n         INT,
  lot_codes TEXT[],
  lot_ids   UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- Prefer columns over the OUT params (kind/key_value/n/…) on bare references.
#variable_conflict use_column
DECLARE
  v_caller UUID := auth.uid();
  v_op     UUID;
BEGIN
  IF v_caller IS NULL THEN RETURN; END IF;
  SELECT operator_id INTO v_op FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE
  active_walk AS (
    -- Every active (scheduled/live) lot, walked up to its lineage root.
    SELECT l.id AS active_id, l.id AS cur, l.relisted_from_lot_id AS parent_id
    FROM lots l
    WHERE l.operator_id = v_op
      AND l.deleted_at IS NULL
      AND l.status IN ('scheduled', 'live')
    UNION ALL
    SELECT aw.active_id, p.id, p.relisted_from_lot_id
    FROM active_walk aw JOIN lots p ON p.id = aw.parent_id
  ),
  active_roots AS (
    SELECT active_id, cur AS root_id FROM active_walk WHERE parent_id IS NULL
  ),
  -- 0294: active lots having an ACTIVE ANCESTOR. This is the direct-line
  -- duplicate — genuinely one box listed twice. DISTINCT because a lot can have
  -- several active ancestors and we only need the fact.
  direct_ids AS (
    SELECT DISTINCT aw.active_id
    FROM active_walk aw
    JOIN lots anc ON anc.id = aw.cur
    WHERE aw.cur <> aw.active_id
      AND anc.deleted_at IS NULL
      AND anc.status IN ('scheduled', 'live')
  ),
  -- 0294: per-root shape. LEFT JOIN is against the DISTINCT set so it cannot
  -- multiply rows and inflate n_active.
  root_stats AS (
    SELECT ar.root_id,
           COUNT(*)                                             AS n_active,
           COUNT(*) FILTER (WHERE act.sticker_code IS NULL)      AS n_unstickered,
           BOOL_OR(d.active_id IS NOT NULL)                      AS has_direct
    FROM active_roots ar
    JOIN lots act        ON act.id = ar.active_id
    LEFT JOIN direct_ids d ON d.active_id = ar.active_id
    GROUP BY ar.root_id
  )
  -- A) source with >1 active child
  SELECT
    'multi_active_child'::TEXT,
    s.lot_code,
    COUNT(*)::INT,
    array_agg(c.lot_code || ' [' || c.status::TEXT || ']' ORDER BY c.created_at),
    array_agg(c.id ORDER BY c.created_at)
  FROM lots c
  JOIN lots s ON s.id = c.relisted_from_lot_id
  WHERE c.operator_id = v_op
    -- 0290: status is authoritative for liveness; canceled_at may be a stale
    -- 0199 audit breadcrumb rather than a death certificate.
    AND (c.canceled_at IS NULL OR c.status IN ('draft', 'scheduled', 'live'))
    AND c.deleted_at IS NULL
    -- 0294: two separately-stickered children are two boxes, not a duplicate.
    AND c.sticker_code IS NULL
  GROUP BY s.id, s.lot_code
  HAVING COUNT(*) > 1

  UNION ALL
  -- B) duplicate sticker_code
  SELECT
    'dup_sticker'::TEXT,
    l.sticker_code,
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.created_at),
    array_agg(l.id ORDER BY l.created_at)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.sticker_code IS NOT NULL
  GROUP BY l.sticker_code
  HAVING COUNT(*) > 1

  UNION ALL
  -- C) duplicate qr_token
  SELECT
    'dup_qr'::TEXT,
    l.qr_token::TEXT,
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.created_at),
    array_agg(l.id ORDER BY l.created_at)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.qr_token IS NOT NULL
  GROUP BY l.qr_token
  HAVING COUNT(*) > 1

  UNION ALL
  -- D) 0294: same lineage root with >1 active listing that are NOT provably
  -- distinct — either a direct-line pair (one box listed twice) or an
  -- unstickered member we cannot tell apart. This is the real defect; it must
  -- read 0 rows.
  SELECT
    'same_root_active'::TEXT,
    root.lot_code,
    COUNT(*)::INT,
    array_agg(act.lot_code || ' [' || act.status::TEXT || ']'
              || CASE WHEN act.sticker_code IS NULL THEN ' no-sticker' ELSE '' END
              ORDER BY act.created_at),
    array_agg(act.id ORDER BY act.created_at)
  FROM active_roots ar
  JOIN root_stats rs ON rs.root_id = ar.root_id
  JOIN lots act      ON act.id = ar.active_id
  JOIN lots root     ON root.id = ar.root_id
  WHERE rs.n_active > 1
    AND (rs.has_direct OR rs.n_unstickered > 0)
  GROUP BY root.id, root.lot_code

  UNION ALL
  -- H) 0294: same root, >1 active listing, every one carrying its own sticker
  -- and none in direct line — separately-stickered boxes from one manifest line
  -- (quantity > 1). LEGITIMATE, reported so the population stays observable
  -- instead of vanishing from the audit.
  SELECT
    'same_root_distinct_units'::TEXT,
    root.lot_code,
    COUNT(*)::INT,
    array_agg(act.lot_code || ' [' || act.status::TEXT || '] ' || act.sticker_code
              ORDER BY act.created_at),
    array_agg(act.id ORDER BY act.created_at)
  FROM active_roots ar
  JOIN root_stats rs ON rs.root_id = ar.root_id
  JOIN lots act      ON act.id = ar.active_id
  JOIN lots root     ON root.id = ar.root_id
  WHERE rs.n_active > 1
    AND NOT rs.has_direct
    AND rs.n_unstickered = 0
  GROUP BY root.id, root.lot_code

  UNION ALL
  -- E) 0290: active lot carrying a cancel stamp. The 0290 trigger makes this
  -- unreachable, so any row here means the trigger was dropped or bypassed —
  -- and every canceled_at-keyed guard is blind again.
  SELECT
    'stale_cancel_stamp'::TEXT,
    to_char(l.canceled_at, 'YYYY-MM-DD HH24:MI:SS'),
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.lot_code),
    array_agg(l.id ORDER BY l.lot_code)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.canceled_at IS NOT NULL
    AND l.status IN ('draft', 'scheduled', 'live')
  GROUP BY l.canceled_at

  UNION ALL
  -- F) 0290: active listing for an item a buyer already paid for AND collected.
  -- Highest-severity row this audit can emit. Note it keys on a SHARED PARENT,
  -- so it still covers the collateral case this migration otherwise relaxes —
  -- if a sibling was collected, the remaining listing is flagged regardless of
  -- stickers.
  SELECT
    'sold_and_collected_still_live'::TEXT,
    sib.lot_code,
    COUNT(*)::INT,
    array_agg(s.lot_code || ' [' || s.status::TEXT || ']' ORDER BY s.lot_code),
    array_agg(s.id ORDER BY s.lot_code)
  FROM lots s
  JOIN lots sib ON sib.relisted_from_lot_id = s.relisted_from_lot_id
                AND sib.id <> s.id
                AND sib.deleted_at IS NULL
  JOIN invoice_lots il ON il.lot_id = sib.id
                       AND il.picked_up_at IS NOT NULL
                       AND il.refunded_at IS NULL
  WHERE s.operator_id = v_op
    AND s.deleted_at IS NULL
    AND s.status IN ('draft', 'scheduled', 'live')
  GROUP BY sib.id, sib.lot_code

  UNION ALL
  -- G) 0290: tombstone parent still holding an auction slot while its child is
  -- live — the "same item twice in one auction" ghost from Jared's note.
  SELECT
    'ghost_parent_on_auction'::TEXT,
    p.lot_code,
    COUNT(*)::INT,
    array_agg(c.lot_code || ' [' || c.status::TEXT || ']' ORDER BY c.created_at),
    array_agg(p.id ORDER BY c.created_at)
  FROM lots p
  JOIN lots c ON c.relisted_from_lot_id = p.id
  WHERE p.operator_id = v_op
    AND p.deleted_at IS NULL
    AND p.auction_id IS NOT NULL
    AND c.deleted_at IS NULL
    AND c.status IN ('draft', 'scheduled', 'live')
  GROUP BY p.id, p.lot_code;
END;
$$;

COMMENT ON FUNCTION public.duplicate_lot_audit() IS
  '0294: operator-scoped duplicate/ghost inventory audit. Eight kinds. '
  'same_root_active now fires only on direct-line or unstickered conflicts — a '
  'root with several separately-stickered active lots is quantity>1, not a '
  'duplicate, and is reported as same_root_distinct_units. Read-only.';

COMMIT;
