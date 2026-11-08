-- 0360 — dispose the 2026-09-11 CSV import batch as duplicate stock.
--
-- Jared, 2026-09-18: the Smart Lot Import was used to stage product data, not
-- to create inventory. Staff are lotting these same physical items by hand
-- right now, so all 1,369 rows from batch bf0107e4-32d3-407e-b5e5-0cf7320b2751
-- ("STL3 116SZLMSG RETAIL.csv", imported 2026-09-11 21:26:21Z) are duplicates
-- of lots being created properly at the bench.
--
-- 0359 already pulled the three that had reached a scheduled auction. This
-- disposes the whole batch.
--
-- ── Why remove_lot_from_inventory and not mark_lot_disposed ──────────────────
--
-- mark_lot_disposed(lot_id, reason) (0146) takes no disposition — it sets
-- status='disposed' and a free-text flagged_reason, and that is all. The
-- function that takes a disposition from a whitelist including 'other', plus a
-- note, is remove_lot_from_inventory(lot_id, kind, note) (0319, whitelist
-- widened by 0352). It sets status='disposed' as well — the
-- lots_removal_implies_disposed constraint requires it — and additionally
-- records removal_kind, removed_at, removed_by and removal_note, then keeps
-- 0146's flagged_for_disposal/flagged_at/flagged_reason consistent so the
-- worklist's flagged section agrees. It is the stronger audit trail and it is
-- what "disposition 'other' with a note" actually describes.
--
-- Its guards all apply and are the reason for using it rather than an UPDATE:
-- admin-or-manager, same-operator, refuses a live lot that has bids, idempotent
-- per kind, and conflict detection if a lot was already removed as something
-- else.
--
-- ── Why the JWT claim is set ────────────────────────────────────────────────
--
-- Both RPCs open with `v_caller UUID := auth.uid()` and RETURN
-- {ok:false, reason:'not_authenticated'} when it is NULL. They return it; they
-- do not raise. Applied through the migration runner the session is `postgres`
-- with auth.uid() = NULL (verified against prod), so a naive loop would call
-- the RPC 1,369 times, be told no 1,369 times, change nothing, and report
-- success. That is the failure this block is shaped to prevent.
--
-- Setting request.jwt.claims for the transaction makes auth.uid() resolve to a
-- real person, so the RPC's own guards genuinely run rather than being bypassed
-- by a direct UPDATE. The actor is the admin who ran the import
-- (404d0e6b-d3b4-445f-9ef4-b94679dc4ea9, confirmed admin on operator
-- 05775af4-adb7-4f0f-943e-94a91e17f60d, which owns these lots), so removed_by
-- points at the person whose action is being undone. set_config(..., true) is
-- transaction-local and does not leak.
--
-- The assumption is then VERIFIED before any work happens. If auth.uid() does
-- not come back as the actor, this raises instead of silently doing nothing.
--
-- ── Safety, measured on prod 2026-09-18 before writing this ─────────────────
--
--   bids 0 · invoice lines 0 · bin assignments 0 · claimed stickers 0
--   sticker_code set 0 · pickup outcomes 0 · pickup-session collections 0
--   relist children 0 · relist_count > 0: 0 · already disposed 0
--   deleted_at set 0 · removal_kind set 0 · auction_id set 0 (after 0359)
--
-- The pre-flight below re-checks every one of those at apply time rather than
-- trusting the measurement, and aborts the whole transaction if any is
-- non-zero.
--
-- Nothing here destroys data: disposal is a status flip. The rows, their
-- titles, descriptions, ASINs and MSRPs all remain, and the batch can be
-- revived by clearing removal_kind and status if this turns out to be wrong.
--
-- Idempotent: a lot already removed as 'other' returns ok+idempotent.

BEGIN;

DO $$
DECLARE
  v_batch  CONSTANT uuid := 'bf0107e4-32d3-407e-b5e5-0cf7320b2751';
  v_actor  CONSTANT uuid := '404d0e6b-d3b4-445f-9ef4-b94679dc4ea9';
  v_note   CONSTANT text :=
    'Duplicate of hand-lotted stock. Smart Lot Import batch bf0107e4 '
    || '(STL3 116SZLMSG RETAIL.csv, 2026-09-11) was used to stage product '
    || 'data, not to create inventory; staff lotted these items individually. '
    || 'Disposed per Jared, 2026-09-18.';
  v_blocked   bigint;
  v_lot       record;
  v_result    jsonb;
  v_ok        bigint := 0;
  v_skipped   bigint := 0;
  v_failed    bigint := 0;
  v_first_err text;
BEGIN
  -- ── Nothing to dispose? Leave before asserting anything about the actor ───
  --
  -- A fresh database has no such batch: CI replays every migration from zero
  -- ("schema migrations" and "embed smoke" in ci.yml), and its auth.uid() is a
  -- stub defined as `SELECT NULL::uuid` (ci.yml:185) that ignores
  -- request.jwt.claims entirely, so the assertion below can never pass there.
  -- Asserting it where there is no work to do would fail this migration's
  -- replay forever — on this PR and on every PR after it.
  --
  -- The assertion still guards the case it exists for: it runs whenever the
  -- batch IS present, which is the only situation in which a silent
  -- not_authenticated no-op could lose real work.
  IF NOT EXISTS (SELECT 1 FROM lots WHERE lot_import_batch_id = v_batch) THEN
    RAISE NOTICE '0360: batch % is not present here, nothing to dispose', v_batch;
    RETURN;
  END IF;

  -- ── Assume the actor, then prove it took ──────────────────────────────────
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_actor::text, 'role', 'authenticated')::text,
    true);

  IF auth.uid() IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      '0360: could not assume actor % — auth.uid() is %. Refusing to run, '
      'because the RPC would return not_authenticated for every lot and this '
      'migration would report success having changed nothing.',
      v_actor, coalesce(auth.uid()::text, 'NULL');
  END IF;

  -- ── Pre-flight: anything that makes a lot unsafe to dispose ───────────────
  SELECT
    (SELECT count(*) FROM bids WHERE lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch))
  + (SELECT count(*) FROM invoice_lots WHERE lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch))
  + (SELECT count(*) FROM bin_assignments WHERE lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch))
  + (SELECT count(*) FROM lot_sticker_pool WHERE claimed_by_lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch))
  + (SELECT count(*) FROM pickup_lot_outcomes WHERE lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch))
  + (SELECT count(*) FROM pickup_sessions ps WHERE EXISTS (
       SELECT 1 FROM lots l WHERE l.lot_import_batch_id = v_batch AND l.id = ANY(ps.collected_lot_ids)))
  + (SELECT count(*) FROM lots c WHERE c.relisted_from_lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch))
  + (SELECT count(*) FROM lots WHERE lot_import_batch_id = v_batch AND auction_id IS NOT NULL)
  INTO v_blocked;

  IF v_blocked > 0 THEN
    RAISE EXCEPTION
      '0360: % blocking reference(s) found across bids / invoice lines / bin '
      'assignments / claimed stickers / pickup outcomes / pickup sessions / '
      'relist children / auction membership. Re-check before disposing.',
      v_blocked;
  END IF;

  -- ── Dispose, one RPC call per lot so every guard runs per lot ─────────────
  FOR v_lot IN
    SELECT id, lot_code FROM lots
     WHERE lot_import_batch_id = v_batch
     ORDER BY lot_code
  LOOP
    v_result := remove_lot_from_inventory(v_lot.id, 'other', v_note);

    IF (v_result->>'ok')::boolean THEN
      IF coalesce((v_result->>'idempotent')::boolean, false) THEN
        v_skipped := v_skipped + 1;
      ELSE
        v_ok := v_ok + 1;
      END IF;
    ELSE
      v_failed := v_failed + 1;
      IF v_first_err IS NULL THEN
        v_first_err := v_lot.lot_code || ': ' || coalesce(v_result->>'reason', '?');
      END IF;
    END IF;
  END LOOP;

  -- A partial disposal is worse than none — half a duplicate batch is harder
  -- to reason about than all of it. Any refusal rolls the whole thing back.
  IF v_failed > 0 THEN
    RAISE EXCEPTION
      '0360: % lot(s) refused disposal (first: %). Disposed % and skipped % '
      'before aborting; all rolled back.',
      v_failed, v_first_err, v_ok, v_skipped;
  END IF;

  RAISE NOTICE '0360: disposed % lot(s), % already disposed', v_ok, v_skipped;
END $$;

COMMIT;
