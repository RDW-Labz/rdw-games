-- 0361 — a CSV import stages stock; put-away is what receives it.
--
-- Second half of the 2026-09-18 fix. The route half ships alongside this:
-- /api/lots/import now passes p_initial_status = 'pending_intake' instead of
-- letting bulk_import_lots fall back to its 'in_inventory' default.
--
-- This half is the timestamp. bulk_import_lots writes intake_at unconditionally
-- as now(), so even a lot created as 'pending_intake' comes out carrying a
-- completed intake record — a receipt for a box nobody has touched. That is
-- what happened to the 1,369 rows of batch bf0107e4 on 2026-09-11: status
-- 'in_inventory', intake_at equal to created_at to the microsecond, and
-- intake_bin_id NULL on every single one. They went straight into Auction
-- Builder's available bucket (status='in_inventory' AND auction_id IS NULL) and
-- three reached a scheduled, pre-bid-enabled auction. 0359 pulled those three;
-- 0360 disposed the batch.
--
-- After this, intake_at is left NULL whenever the initial status is
-- 'pending_intake', and put-away stamps it on physical receipt the way 0354
-- already does. Any caller asking for a different initial status — the
-- legacy-platform migrate path is the only other one — keeps today's behaviour.
--
-- ── Why a surgical patch rather than re-pasting the function ────────────────
--
-- bulk_import_lots is ~250 lines last redefined by 0178, and re-pasting it to
-- change one expression invites the body drifting from whatever is actually
-- deployed. 0352 hit the same problem widening this codebase's removal-kind
-- whitelist and solved it by reading pg_get_functiondef, patching the one line,
-- and refusing to proceed if the target was not found. This follows that.
--
-- Measured against prod before writing (2026-09-18):
--   • signature: bulk_import_lots(text,text,jsonb,jsonb,boolean,uuid,
--                                 lot_status,boolean,uuid)
--   • the stored body uses CRLF line endings, so the pattern is written
--     whitespace-tolerant rather than matching a literal newline
--   • 'p_initial_status,<ws>now(),' matches exactly ONCE
--   • now() appears exactly ONCE in the entire function, so there is no
--     neighbouring call to hit by accident
--   • the body does not yet mention 'pending_intake'
--
-- Every one of those is re-asserted below at apply time. If any has changed,
-- this raises and writes nothing rather than guessing.
--
-- Idempotent: a body already mentioning 'pending_intake' is left alone.
-- CREATE OR REPLACE preserves the function's owner and grants.

BEGIN;

DO $do$
DECLARE
  v_sig  CONSTANT text :=
    'public.bulk_import_lots(text,text,jsonb,jsonb,boolean,uuid,lot_status,boolean,uuid)';
  v_oid     oid;
  v_src     text;
  v_new     text;
  v_hits    int;
BEGIN
  -- ── The function must exist with exactly this signature ──────────────────
  v_oid := to_regprocedure(v_sig);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      '0361: % not found. Its signature changed since this was written — '
      'refusing to guess which overload to patch.', v_sig;
  END IF;

  v_src := pg_get_functiondef(v_oid);

  -- ── Already done? ────────────────────────────────────────────────────────
  IF v_src LIKE '%pending_intake%' THEN
    RAISE NOTICE '0361: bulk_import_lots already leaves intake_at NULL for pending_intake, nothing to do';
    RETURN;
  END IF;

  -- ── The target must be exactly one place, and now() must be unambiguous ──
  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_src, 'p_initial_status,\s*now\(\),', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '0361: expected exactly 1 "p_initial_status, now()," in bulk_import_lots, found %. '
      'The INSERT changed shape — patch it by hand rather than letting this guess.', v_hits;
  END IF;

  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_src, 'now\(\)', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '0361: expected exactly 1 now() in bulk_import_lots, found %. Another timestamp '
      'call has appeared and the patch is no longer provably unambiguous.', v_hits;
  END IF;

  -- ── Patch: intake_at is NULL for stock that has not been received ────────
  -- \1 keeps whatever whitespace (CRLF + indent) sat between the two values,
  -- so the rewritten body stays readable in pg_get_functiondef.
  v_new := regexp_replace(
    v_src,
    'p_initial_status,(\s*)now\(\),',
    'p_initial_status,\1CASE WHEN p_initial_status = ''pending_intake'' THEN NULL ELSE now() END,'
  );

  IF v_new = v_src THEN
    RAISE EXCEPTION '0361: replacement produced no change — refusing to claim success.';
  END IF;

  EXECUTE v_new;

  -- ── Prove the deployed function is the patched one ───────────────────────
  v_src := pg_get_functiondef(to_regprocedure(v_sig));
  IF v_src NOT LIKE '%CASE WHEN p_initial_status = ''pending_intake'' THEN NULL ELSE now() END%' THEN
    RAISE EXCEPTION
      '0361: the replace ran but the stored definition does not contain the new '
      'expression. Aborting so this cannot report success having changed nothing.';
  END IF;

  RAISE NOTICE '0361: bulk_import_lots now leaves intake_at NULL when the initial status is pending_intake';
END $do$;

COMMIT;
