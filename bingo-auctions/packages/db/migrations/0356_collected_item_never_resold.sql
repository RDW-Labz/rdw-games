-- 0356 — an item a customer carried out can never come back to auction through
--        ANY lot in its lineage, and a late pickup puts the lot back to 'won'.
--
-- ── THE REPORT ──────────────────────────────────────────────────────────────
-- Owner, 2026-09-14: items are handed over at the counter, then forfeited in
-- the app and relisted, and the second buyer finds an empty shelf. Audit:
-- docs/audits/flagged-items-pickup-forfeit-relist-2026-09-14.md.
--
-- ── WHAT THE AUDIT FOUND ────────────────────────────────────────────────────
-- The wave itself is over. 0337 (08-27) made partially-collected pickups
-- sweepable while the sweep still reclaimed EVERY lot on the invoice; 0351
-- (09-10) added the per-lot guard. 301 collected lines were reclaimed in those
-- 14 days, 0 before, 0 since. 0355 (09-14) then refused to relist a collected
-- lot. Both hold on prod. Three holes remain, and this migration closes them:
--
--   1. 0355 reads the pickup stamp of the DIRECT parent only. 197 collected
--      lots had already been relisted before it landed; 19 of those children
--      sit 'unsold' today and can be relisted freely, because the child has no
--      pickup line of its own. The signal lives on the grandparent.
--
--   2. A late pickup leaves the lot 'unsold'. The sweep forfeits at 18:00 with
--      zero grace; 21 of 24 late collections happened within 24 h. The field
--      app stamps the line and completes the pickup but never touches
--      lots.status, so the lot stays in the worklist and the Auction Builder.
--      14 of 24 were relisted anyway; 4 resold. 0355 now refuses the relist,
--      but its message says "refund or put it back", which is wrong advice for
--      an item the rightful buyer just collected.
--
--   3. The customer's own tick on their pickup pass (collected_lot_ids) is
--      honoured by the sweep (0351) but not at relist time. 3 'unsold' lots
--      are relistable on that signal alone. The tick is not proof — in all 7
--      cases where a second buyer actually collected a "gone" item, the only
--      signal on the parent was a tick — so it blocks with its own code and
--      clears the same way as everything else: somebody scans the box.
--
--   4. (latent, zero instances) markPickup('completed') on the console and the
--      counter session page, and the legacy bidder confirm_pickup RPC, complete
--      the pickups row without stamping the lines. Every one of the 370
--      console-completed pickups on prod had its lines stamped by the field
--      app first, so no damage — yet. Completing a pickup now stamps its open
--      lines, so those buttons cannot become the next hole.
--
-- ── WHAT IS DELIBERATELY ALLOWED ────────────────────────────────────────────
-- Same three clearances as 0355, applied across the lineage: the line was
-- refunded, the whole invoice was refunded, or somebody physically put the box
-- back (a lot_location_events row on ANY lineage member after the signal —
-- 0354 makes Put-away write that row even when the bin does not change, so
-- staff clear every block here by scanning the box at Put-away).
--
-- No data is repaired here. The 82 open second-buyer promises and the 19
-- unsold ghosts are listed in the audit for the owner to decide; the guards
-- below stop them from multiplying.

BEGIN;

-- ── 1 + 3. Lineage-aware relist guard: staff stamp (hard) and customer tick ──
-- Replaces the 0355 body. The trigger definition is unchanged.
CREATE OR REPLACE FUNCTION public.lots_block_relist_of_collected_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_hit  RECORD;
  v_code TEXT;
  v_src  TEXT;
BEGIN
  -- Only relist children are candidates; an ordinary new lot is never blocked.
  IF NEW.relisted_from_lot_id IS NULL THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE lineage AS (
    -- The source lot and every ancestor: every row that has ever described
    -- this physical box. Depth-capped so a cyclic back-pointer cannot hang.
    SELECT l.id, l.relisted_from_lot_id, 0 AS depth
      FROM lots l WHERE l.id = NEW.relisted_from_lot_id
    UNION ALL
    SELECT l.id, l.relisted_from_lot_id, lg.depth + 1
      FROM lots l JOIN lineage lg ON l.id = lg.relisted_from_lot_id
     WHERE lg.depth < 50
  ),
  -- (a) Hard signal: a staff pickup stamp on a line that was not refunded, on
  --     an invoice that was not refunded as a whole (that path leaves lines
  --     unstamped, so reading only the line would block a real return).
  stamped AS (
    SELECT il.lot_id, il.picked_up_at AS at, 'stamped'::text AS kind
      FROM lineage lg
      JOIN invoice_lots il ON il.lot_id = lg.id
      JOIN invoices i ON i.id = il.invoice_id
     WHERE il.picked_up_at IS NOT NULL
       AND il.refunded_at IS NULL
       AND i.status <> 'refunded'
  ),
  -- (b) Soft signal: the customer ticked the item on their pickup pass. The
  --     tick time is not stored; the session's creation is the earliest it
  --     could have happened, so that is the mark a put-away must postdate.
  ticked AS (
    SELECT il.lot_id, ps.created_at AS at, 'ticked'::text AS kind
      FROM lineage lg
      JOIN pickup_sessions ps ON ps.collected_lot_ids @> ARRAY[lg.id]
      JOIN invoice_lots il ON il.lot_id = lg.id
      JOIN invoices i ON i.id = il.invoice_id
     WHERE il.refunded_at IS NULL
       AND i.status <> 'refunded'
  ),
  signals AS (SELECT * FROM stamped UNION ALL SELECT * FROM ticked)
  SELECT s.lot_id, s.at, s.kind
    INTO v_hit
    FROM signals s
   WHERE NOT EXISTS (
           -- Somebody physically put the box back on a shelf since. The box
           -- may have been scanned under any of its lot codes.
           --
           -- A lot's BIRTH event does not count. lots_log_intake_move fires
           -- AFTER INSERT, and relist_lot_into_auction copies intake_bin_id to
           -- the child, so every relist child is born with a location event
           -- stamped at its own created_at. Measured on prod before this
           -- shipped: 1,757 of the last 2,041 relist children carry one, and
           -- 18 of the 19 ghost children this guard exists for would have
           -- been cleared by their own minting. A person's Put-away scan is
           -- always later than the row it is scanned against.
           SELECT 1 FROM lot_location_events e
             JOIN lots m ON m.id = e.lot_id
            WHERE e.lot_id IN (SELECT id FROM lineage)
              AND e.occurred_at > s.at
              AND e.occurred_at > m.created_at + interval '5 seconds'
         )
   ORDER BY CASE s.kind WHEN 'stamped' THEN 0 ELSE 1 END, s.at DESC
   LIMIT 1;

  IF v_hit IS NULL THEN
    RETURN NEW;                      -- never collected, refunded, or put back
  END IF;

  SELECT COALESCE(p.display_code, p.lot_code, p.id::text) INTO v_code
    FROM lots p WHERE p.id = v_hit.lot_id;
  SELECT COALESCE(p.display_code, p.lot_code, p.id::text) INTO v_src
    FROM lots p WHERE p.id = NEW.relisted_from_lot_id;

  -- Named error codes so callers present guidance, not a database failure.
  -- Written for somebody holding a tablet. The first code is 0355's, kept
  -- byte-identical so existing callers keep matching it.
  IF v_hit.kind = 'stamped' THEN
    RAISE EXCEPTION
      'relist_blocked_item_collected: % was collected by a customer on % (this box was lot % then) '
      'and has not been refunded or put back since. If it is on the shelf, scan it at '
      'Put-away first. If the customer kept it, refund the line instead of relisting it.',
      v_src, to_char(v_hit.at AT TIME ZONE 'America/Chicago', 'Mon FMDD'), v_code
      USING ERRCODE = 'P0001';
  ELSE
    RAISE EXCEPTION
      'relist_blocked_item_ticked_collected: the customer marked % collected on their pickup pass '
      '(visit of %, as lot %) and nobody has scanned it onto a shelf since. Find the box and '
      'scan it at Put-away to clear this. If the customer has it, refund the line instead.',
      v_src, to_char(v_hit.at AT TIME ZONE 'America/Chicago', 'Mon FMDD'), v_code
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.lots_block_relist_of_collected_item() IS
  '0355/0356: refuses to mint a relist child when the source lot OR ANY OF ITS '
  'ANCESTORS carries an unrefunded pickup stamp (relist_blocked_item_collected) '
  'or an unrefunded customer pickup-pass tick (relist_blocked_item_ticked_collected) '
  'with no lot_location_events row on any lineage member since (a lot''s own birth event does not count). Enforced at the '
  'table so no relist path can miss it; cleared from the floor by a Put-away scan.';

-- ── 2. A late pickup puts the lot back where it belongs ─────────────────────
-- Fires on every writer of the stamp (staff_confirm_pickup, the manager
-- override, and the completion trigger below). Only an 'unsold' lot with no
-- live relist child moves: a lot that already has a child is a lineage
-- question for a person, and a 'relisted' parent is a tombstone by design.
CREATE OR REPLACE FUNCTION public.invoice_lots_late_pickup_restores_won()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE lots l
     SET status     = 'won',
         updated_at = now()
   WHERE l.id = NEW.lot_id
     AND l.status = 'unsold'
     AND NOT EXISTS (
           SELECT 1 FROM lots c
            WHERE c.relisted_from_lot_id = l.id
              AND c.deleted_at IS NULL
              AND c.status <> 'canceled'
         );
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.invoice_lots_late_pickup_restores_won() IS
  '0356: when a line gains its pickup stamp and its lot is ''unsold'' (the '
  'no-show sweep or a console forfeit had reclaimed it) with no live relist '
  'child, the lot goes back to ''won''. The rightful buyer collected it; it is '
  'not stock. Leaves lots that already have a child for a person to untangle.';

DROP TRIGGER IF EXISTS invoice_lots_late_pickup_restores_won_trg ON public.invoice_lots;
CREATE TRIGGER invoice_lots_late_pickup_restores_won_trg
  AFTER UPDATE OF picked_up_at ON public.invoice_lots
  FOR EACH ROW
  WHEN (NEW.picked_up_at IS NOT NULL AND OLD.picked_up_at IS NULL)
  EXECUTE FUNCTION public.invoice_lots_late_pickup_restores_won();

-- ── 4. Completing a pickup stamps what it handed over ───────────────────────
-- The field app and the manager override stamp first and complete second, so
-- this is a no-op for them. It exists for the console's "Mark complete", the
-- counter session page's "Complete N paid pickups" and the legacy bidder
-- bin-scan RPC, which complete the row and leave every line looking owed —
-- invisible to 0355/0356, to the sweep guard, and to the counter screens.
--
-- Lines the staff explicitly marked 'missing' (refund queue) or 'left_behind'
-- (return trip) were NOT handed over and keep their state. Refunded lines are
-- resolved already. A forfeited_at line IS stamped: the only way a forfeited
-- pickup reaches 'completed' is a person at the counter closing a late visit,
-- and that stamp is exactly what flips the lot back to 'won' above.
CREATE OR REPLACE FUNCTION public.stamp_completed_pickup_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    UPDATE invoice_lots il
       SET picked_up_at = COALESCE(NEW.completed_at, now())
     WHERE il.invoice_id = NEW.invoice_id
       AND il.picked_up_at IS NULL
       AND il.refunded_at IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM pickup_lot_outcomes o
              WHERE o.pickup_id = NEW.id
                AND o.lot_id = il.lot_id
                AND o.outcome IN ('missing', 'left_behind')
           );
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.stamp_completed_pickup_lines() IS
  '0356: mirrors a pickup reaching ''completed'' onto its still-open invoice_lots '
  'as picked_up_at = completed_at, skipping refunded lines and lines marked '
  'missing / left_behind. Makes the console and session-page completion paths '
  'as truthful as the field app''s.';

DROP TRIGGER IF EXISTS trg_stamp_completed_pickup_lines ON public.pickups;
CREATE TRIGGER trg_stamp_completed_pickup_lines
  AFTER UPDATE OF status ON public.pickups
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_completed_pickup_lines();

COMMIT;
