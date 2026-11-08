-- 0353 — relot puts an item back in inventory; it does NOT put it in an auction.
--
-- ── THE OWNER'S RULE ────────────────────────────────────────────────────────
-- 2026-09-10, after relotting TEA5009300 to dispose of it: "As soon as I
-- selected Relot, the system automatically scheduled the item into an auction
-- before I could dispose of it. I do not want anything automatically scheduled
-- into an auction—ever. Every item must remain unscheduled until an employee
-- deliberately chooses an auction and confirms the assignment."
--
-- He is describing exactly what happened. The child lot was created 14:25:50
-- already attached to "Sweater Weather Steals" and disposed 48 seconds later —
-- and it is STILL attached to that scheduled auction, because disposal does
-- not detach. Ten more disposed lots are sitting in live/scheduled auctions
-- the same way.
--
-- The auto-pick was never a deliberate design: relot.tsx and the worklist
-- Relist button both grab "the soonest-closing draft or scheduled auction at
-- this warehouse" and commit in the same tap. Staff were never asked.
--
-- ── WHY in_inventory AND NOT A NEW STATUS ───────────────────────────────────
-- lot_status already has in_inventory, and assign_lots_to_auction (0294) will
-- ONLY accept a lot in that status — it raises lot_not_in_inventory for
-- anything else. So the "Needs Auction Assignment" state the owner is asking
-- for is already the state the assignment RPC is built around. Minting the
-- relot child there means the deliberate second step already exists and is
-- already guarded; nothing new has to be invented or kept in sync.
--
-- ── CHANGE 2: A FULLY REFUNDED 'won' LOT CAN BE RELOTTED ────────────────────
-- Separately, the owner reported refunded stock filling the back room. There
-- are 853 refunded lots still sitting in status 'won' — 847 of them occupying
-- a physical bin, averaging 30 days, oldest 69. They are stuck twice over:
-- nothing surfaces them (won reads as sold, so no unsold sweep and no report
-- reaches them), and relist_lot_into_auction REFUSES them outright —
-- verified against prod: "relist_source_wrong_status: won".
--
-- So the only way to put a refunded item back to work today is to hand-edit
-- it on the operator console. That is why 4 of 853 were ever relotted.
--
-- 'won' is widened here ONLY when the lot has invoice lines and every one of
-- them is refunded — i.e. nobody owns it any more. A lot with even one live
-- unrefunded line still belongs to a customer and stays refused. This is the
-- same "nobody has a claim" predicate 0329 already uses when deciding whether
-- a lineage member's sticker may be reclaimed; it is not a new rule.
--
-- 0345's missing-item trigger is untouched and still fires underneath: an item
-- refunded as MISSING cannot be relisted until somebody physically finds it.
--
-- ── METHOD ──────────────────────────────────────────────────────────────────
-- Surgical patch of the deployed definition rather than a re-paste. The body
-- carries sticker/lineage logic that has been repaired repeatedly (0192, 0213,
-- 0275, 0296, 0314) and re-pasting it from a migration file risks silently
-- reverting a later fix. Each replace must match exactly once or the whole
-- migration aborts having changed nothing.

DO $mig$
DECLARE
  v_src  TEXT;
  v_new  TEXT;
  v_hits INT;

  -- ── anchors, verbatim from the deployed body ──
  a_status   CONSTANT TEXT := '  IF v_src.status NOT IN (''unsold'', ''in_inventory'', ''relisted'') THEN
    RAISE EXCEPTION ''relist_source_wrong_status: %'', v_src.status
      USING ERRCODE = ''P0001'';
  END IF;';

  a_auction  CONSTANT TEXT := '  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id;
  IF v_auction.id IS NULL THEN
    RAISE EXCEPTION ''relist_target_auction_not_found'' USING ERRCODE = ''P0001'';
  END IF;
  IF v_auction.operator_id <> v_src.operator_id THEN
    RAISE EXCEPTION ''relist_cross_tenant'' USING ERRCODE = ''42501'';
  END IF;
  IF v_auction.warehouse_id <> v_src.warehouse_id THEN
    RAISE EXCEPTION ''relist_target_different_warehouse'' USING ERRCODE = ''P0001'';
  END IF;
  IF v_auction.status NOT IN (''draft'', ''scheduled'') THEN
    RAISE EXCEPTION ''relist_target_wrong_status: %'', v_auction.status
      USING ERRCODE = ''P0001'';
  END IF;';

  a_lock     CONSTANT TEXT := '  PERFORM pg_advisory_xact_lock(hashtextextended(p_auction_id::TEXT, 0));

  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_lot_number
  FROM lots WHERE auction_id = p_auction_id;';

  a_insert   CONSTANT TEXT := '    v_auction.ends_at, ''scheduled'',';
BEGIN
  v_src := pg_get_functiondef('public.relist_lot_into_auction(uuid,uuid)'::regprocedure);

  -- Idempotence: if 0353 already ran, its marker is present.
  IF v_src LIKE '%0353%' THEN
    RAISE NOTICE '0353 already applied to relist_lot_into_auction; nothing to do.';
    RETURN;
  END IF;

  -- Every anchor must appear exactly once.
  FOR v_hits IN
    SELECT n FROM (VALUES
      ((length(v_src) - length(replace(v_src, a_status,  ''))) / length(a_status)),
      ((length(v_src) - length(replace(v_src, a_auction, ''))) / length(a_auction)),
      ((length(v_src) - length(replace(v_src, a_lock,    ''))) / length(a_lock)),
      ((length(v_src) - length(replace(v_src, a_insert,  ''))) / length(a_insert))
    ) AS t(n)
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '0353 aborted: an anchor matched % times, expected exactly 1. '
                      'The deployed body has drifted — re-derive the anchors.', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;

  -- ── 1. Source status: allow a 'won' lot nobody owns any more ──────────────
  v_new := replace(v_new, a_status,
'  -- 0353: ''won'' is allowed ONLY when the lot has invoice lines and every one
  -- of them is refunded, i.e. no customer has a claim on the item. A lot with
  -- one live unrefunded line still belongs to somebody and stays refused.
  IF v_src.status NOT IN (''unsold'', ''in_inventory'', ''relisted'')
     AND NOT (
       v_src.status = ''won''
       AND EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = p_lot_id)
       AND NOT EXISTS (
         SELECT 1 FROM invoice_lots il
          WHERE il.lot_id = p_lot_id
            AND il.refunded_at IS NULL
       )
     )
  THEN
    RAISE EXCEPTION ''relist_source_wrong_status: %'', v_src.status
      USING ERRCODE = ''P0001'';
  END IF;');

  -- ── 2. Target auction is now optional ─────────────────────────────────────
  v_new := replace(v_new, a_auction,
'  -- 0353: p_auction_id NULL = relot to inventory, unscheduled. The auction
  -- checks below only apply when a caller actually named an auction.
  IF p_auction_id IS NOT NULL THEN
' || a_auction || '
  END IF;');

  -- ── 3. No auction means no per-auction lock and no lot_number ─────────────
  v_new := replace(v_new, a_lock,
'  IF p_auction_id IS NOT NULL THEN
' || a_lock || '
  END IF;');

  -- ── 4. The child is born unscheduled ──────────────────────────────────────
  -- v_auction is never assigned on the NULL path, so v_auction.ends_at is
  -- already NULL and close_at lands NULL, which is what in_inventory wants.
  -- The ::lot_status cast is load-bearing. A bare CASE over two string
  -- literals resolves to text, and the INSERT then fails with "column status
  -- is of type lot_status but expression is of type text" on EVERY call, not
  -- just the unscheduled one. Caught in a rolled-back probe against prod.
  v_new := replace(v_new, a_insert,
'    v_auction.ends_at,
    (CASE WHEN p_auction_id IS NULL THEN ''in_inventory'' ELSE ''scheduled'' END)::lot_status,');

  EXECUTE v_new;
END
$mig$;

COMMENT ON FUNCTION public.relist_lot_into_auction(uuid, uuid) IS
  '0329/0353: mints the relist child. p_auction_id NULL relots the item to '
  'in_inventory, unscheduled and unattached — the owner''s rule is that nothing '
  'is ever auto-scheduled, so auction assignment is a separate deliberate step '
  'via assign_lots_to_auction. A ''won'' source is accepted only when every '
  'invoice line for it is refunded (nobody owns it).';
