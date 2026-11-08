-- 0284 — one-time data cleanup: retire the STALE legacy copy of each
--        both-in_inventory duplicate "twin" pair (Prong 3 of the 2026-07-22
--        duplicate-lot fix; see 0283 for prevention, and the Prong-1 client
--        resolver change).
--
-- DUPLICATE TWIN (recap): a go-live import lot (lot_code=BRN…/GRA…/TEA…/PPE…,
-- created 2026-05-25) and a re-lotted lot (lot_code=BIN-######, carrying
-- sticker_code='BIN:'||<legacy lot_code>, created 2026-07-15/16) that describe
-- the SAME physical item. Both are status='in_inventory' and sit in the SAME
-- bin, so the item shows TWICE in Bin Lookup (Jared: BRN4371659) and a
-- lot_code-first scan can land on the stale legacy copy (Jared: BRN4374140).
--
-- SCOPE (dry-run verified against prod 2026-07-23, run 30020401351 +
-- aggregate): the BinGo operator's twin pairs where BOTH sides are
-- 'in_inventory'. For every such pair the twin is NEWER than the legacy, both
-- sit in the SAME intake bin, and NEITHER side has an invoice_lots or
-- bin_assignments (staging) row — i.e. no customer / pickup / auction state is
-- attached, so retiring the legacy copy is side-effect-free.
--
-- ACTION: soft-retire the LEGACY copy → status='canceled' (the same soft,
-- reversible, dashboard-visible retire discard_lot/0249 uses). We KEEP the
-- twin (newer, carries the operator sticker, matches the customer Pickup Pass)
-- and KEEP the legacy's intake_bin_id so the retire is fully reversible. A
-- 'canceled' lot is excluded from Bin Lookup's PRESENT_STATUSES, so the bin
-- immediately stops showing the item twice, and preferActiveLot (Prong 1)
-- already prefers the active twin in Lot Lookup / Relot.
--
-- NOT TOUCHED HERE: pairs where either side is 'won' (a customer owns it —
-- reviewed separately) or already retired; anything with an invoice/staging
-- row; other operators. The self-limiting WHERE below enforces all of that,
-- so this migration is safe to re-run (idempotent: a legacy already 'canceled'
-- no longer matches).

BEGIN;

-- Target set: the legacy copy of each both-in_inventory BinGo twin pair, with
-- every safety filter that the dry-run confirmed holds for the whole set.
CREATE TEMP TABLE _dedup_targets ON COMMIT DROP AS
SELECT l.id AS legacy_id, l.lot_code AS legacy_code, l.status AS before_status,
       l.intake_bin_id AS before_bin, t.id AS twin_id, t.lot_code AS twin_code
FROM public.lots l
JOIN public.operators o ON o.id = l.operator_id AND o.code = 'BIN'
JOIN public.lots t
  ON t.operator_id = l.operator_id
 AND t.sticker_code = o.code || ':' || l.lot_code
 AND t.id <> l.id
 AND t.status = 'in_inventory'
 AND t.deleted_at IS NULL
 AND t.created_at > l.created_at            -- twin is the newer re-lot
WHERE l.status = 'in_inventory'
  AND l.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.invoice_lots il WHERE il.lot_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM public.bin_assignments ba WHERE ba.lot_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM public.invoice_lots il WHERE il.lot_id = t.id);

-- Audit trail: one row per retired legacy copy (actor is NULL — a migration,
-- not a staff action), recording the twin it was deduped in favour of.
INSERT INTO public.operator_audit_log
  (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
SELECT
  (SELECT id FROM public.operators WHERE code = 'BIN'),
  NULL,
  'lot_dedup_retired',
  d.legacy_id,
  jsonb_build_object('status', d.before_status, 'intake_bin_id', d.before_bin, 'lot_code', d.legacy_code),
  jsonb_build_object('status', 'canceled', 'kept_twin_id', d.twin_id, 'kept_twin_code', d.twin_code),
  '0284 dedup: retired stale legacy twin in favour of re-lotted ' || d.twin_code
FROM _dedup_targets d;

-- Retire the legacy copies. intake_bin_id is intentionally preserved so the
-- retire is reversible (flip status back to 'in_inventory' to restore).
UPDATE public.lots
   SET status = 'canceled', updated_at = now()
 WHERE id IN (SELECT legacy_id FROM _dedup_targets);

-- Surface the affected count in the apply log.
DO $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM _dedup_targets;
  RAISE NOTICE '0284: retired % legacy twin copies (status -> canceled).', v_n;
END $$;

COMMIT;
