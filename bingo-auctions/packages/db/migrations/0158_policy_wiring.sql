-- ============================================================================
-- 0158_policy_wiring.sql
--
-- PR-A2 of the operator-customizable post-win policy plan. Wires the money-
-- flow paths to read from operator_policies columns that PR-A1 added (mig
-- 0157). See docs/audits/pra2-prep-audit-2026-05-29.md for the verification
-- audit driving these changes.
--
-- ZERO BEHAVIOR CHANGE AT DEFAULTS. Every read falls back to the value that
-- was hardcoded today:
--   - relist_fee_cents default 500 (= apply_relot_fee's old hardcoded $5)
--   - no_show_policy default 'full_forfeit' (= today's silent forfeiture)
--   - operators.auto_charge_grace_hours default 48 (= the hardcoded
--     GRACE_WINDOW_MS = 48 * 60 * 60 * 1000 in auto-charge-drain.ts; that
--     constant is replaced in the same PR via a code edit, not in this
--     migration — included here in the comment so future readers
--     understand the full PR-A2 scope.)
--
-- WHAT THIS MIGRATION DOES
--   1. Adds 3 new notification_kind enum values:
--        - relot_fee_applied              (FIXES LATENT BUG — grace-expiry.ts:154
--          inserts this kind today but the enum doesn't have it, so the insert
--          silently fails. Adding it heals the bug as a bonus.)
--        - pickup_no_show_forfeit          (new — for full_forfeit no-show path)
--        - pickup_no_show_refund_pending   (new — for refund_minus_restock no-show
--          path; PR-A2 emits the notification but doesn't issue the Stripe
--          refund — that's deferred to a follow-up PR with a refund_jobs queue.)
--   2. CREATE OR REPLACE apply_relot_fee to read relist_fee_cents from the
--      operator's latest published policy when p_amount_cents is NULL.
--      Signature change: default 500 → NULL. Existing caller passes no value;
--      new body looks up the policy and falls back to 500 if no policy exists
--      (defensive). Callers that pass an explicit value are unaffected.
--   3. CREATE OR REPLACE auto_mark_pickup_no_show to ALSO emit:
--        - notifications_outbox row per affected invoice (bidder gets push)
--        - operator_audit_log row per affected invoice (operator gets audit trail)
--      Branch on no_show_policy for the notification kind + audit action_type.
--      LOT STATUS FLIP BEHAVIOR IS PRESERVED (still goes to 'unsold' as today).
--      DOES NOT issue Stripe refunds (deferred to PR-C with refund_jobs queue).
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - No new tables, no Stripe API calls, no refund_jobs queue.
--   - Does not change the pg_cron schedule (still */30 * * * * UTC from mig 0155).
--   - Does not modify grace-expiry.ts (covered by the apply_relot_fee body change).
--   - Does not touch auto_charge_jobs, place_bid, webhook handlers,
--     refund route, bidder_fee_ledger schema, or any Stripe code path.
-- ============================================================================

-- ── 1. Add missing notification_kind enum values ───────────────────────────
-- Postgres rule: ALTER TYPE ADD VALUE is allowed inside a transaction since
-- PG 12, BUT the new value cannot be USED (compared to, inserted) in the
-- same transaction. CREATE OR REPLACE FUNCTION below references the new
-- values inside function bodies — that's fine, the bodies aren't executed
-- during CREATE, only parsed.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'relot_fee_applied';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'pickup_no_show_forfeit';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'pickup_no_show_refund_pending';

-- ── 2. apply_relot_fee — read policy when amount not explicit ──────────────
-- Default change: p_amount_cents BIGINT DEFAULT 500 → DEFAULT NULL.
-- Existing caller grace-expiry.ts:107 invokes without p_amount_cents → param
-- arrives as NULL → body looks up policy → falls back to 500 (same as today)
-- if no published policy exists for the operator.

CREATE OR REPLACE FUNCTION apply_relot_fee(
  p_invoice_id   UUID,
  p_amount_cents BIGINT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder_id     UUID;
  v_operator_id   UUID;
  v_amount_cents  BIGINT;
  v_new_total     BIGINT;
BEGIN
  SELECT bidder_id, operator_id
    INTO v_bidder_id, v_operator_id
    FROM invoices WHERE id = p_invoice_id;
  IF v_bidder_id IS NULL THEN
    RAISE EXCEPTION 'invoice % has no bidder', p_invoice_id;
  END IF;

  -- PR-A2: if no explicit amount given, read from operator's latest published
  -- policy. Falls back to 500c (today's hardcoded value) if no policy is
  -- published or column is NULL. Existing default behavior preserved.
  IF p_amount_cents IS NULL THEN
    SELECT op.relist_fee_cents
      INTO v_amount_cents
      FROM operator_policies op
     WHERE op.operator_id = v_operator_id
       AND op.published = TRUE
     ORDER BY op.version DESC
     LIMIT 1;
    v_amount_cents := COALESCE(v_amount_cents, 500);
  ELSE
    v_amount_cents := p_amount_cents;
  END IF;

  INSERT INTO bidder_fee_ledger (bidder_id, invoice_id, amount_cents, reason)
  VALUES (v_bidder_id, p_invoice_id, v_amount_cents, 'relot_fee')
  ON CONFLICT (invoice_id) WHERE invoice_id IS NOT NULL
  DO NOTHING;

  UPDATE bidders b
     SET unpaid_fees_cents = COALESCE(
       (SELECT SUM(amount_cents) FROM bidder_fee_ledger
         WHERE bidder_id = v_bidder_id AND paid_at IS NULL),
       0
     )
   WHERE b.id = v_bidder_id
   RETURNING unpaid_fees_cents INTO v_new_total;

  RETURN v_new_total;
END;
$$;

REVOKE ALL ON FUNCTION apply_relot_fee(UUID, BIGINT) FROM PUBLIC;

COMMENT ON FUNCTION apply_relot_fee(UUID, BIGINT) IS
  'Applies a relot fee to a bidder''s outstanding balance. As of PR-A2 '
  '(2026-05-29), if p_amount_cents is NULL the function reads '
  'operator_policies.relist_fee_cents from the operator''s latest published '
  'policy (falls back to 500c if none). Explicit amounts still work for '
  'admin-override cases.';

-- ── 3. auto_mark_pickup_no_show — add notifications + audit log ────────────
-- The function preserves the existing pickup → no_show + lot → unsold flips.
-- After the flips, it inserts:
--   - notifications_outbox row per affected invoice, branched on policy
--   - operator_audit_log row per affected invoice
-- The "just flipped" filter uses pickups.updated_at >= now() - INTERVAL '5
-- minute' to scope to rows the same cron pass just touched (advisory lock
-- prevents overlap).

CREATE OR REPLACE FUNCTION auto_mark_pickup_no_show()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pickup_count INT := 0;
  v_lot_count    INT := 0;
  v_notify_count INT := 0;
  v_audit_count  INT := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(7423940155) THEN
    RETURN jsonb_build_object('skipped', 'lock_held');
  END IF;

  -- Step 1: find pickups past deadline (with operator's grace extension).
  WITH due AS (
    SELECT p.id AS pickup_id, p.invoice_id
    FROM pickups p
    JOIN invoices  i ON i.id = p.invoice_id
    JOIN auctions  a ON a.id = i.auction_id
    JOIN operators o ON o.id = i.operator_id
    WHERE p.status IN ('pending', 'scheduled')
      AND (
        COALESCE(p.scheduled_at, a.pickup_ends_at)
          + (COALESCE(o.pickup_grace_extension_hours, 24) * INTERVAL '1 hour')
      ) < now()
  ),
  flipped AS (
    UPDATE pickups
       SET status = 'no_show', updated_at = now()
     WHERE id IN (SELECT pickup_id FROM due)
    RETURNING id, invoice_id
  )
  SELECT COUNT(*) INTO v_pickup_count FROM flipped;

  -- Step 2: route affected lots to 'unsold' (behavior preserved from mig 0155).
  WITH no_show_invoices AS (
    SELECT DISTINCT invoice_id FROM pickups WHERE status = 'no_show'
  ),
  no_show_lot_ids AS (
    SELECT il.lot_id
    FROM invoice_lots il
    JOIN no_show_invoices nsi ON nsi.invoice_id = il.invoice_id
  ),
  routed AS (
    UPDATE lots
       SET status = 'unsold', updated_at = now()
     WHERE id IN (SELECT lot_id FROM no_show_lot_ids)
       AND status = 'won'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_lot_count FROM routed;

  -- PR-A2 Step 3a: emit notifications_outbox for each just-flipped no-show.
  -- The CTE gathers per-invoice policy + bidder info via LATERAL join to the
  -- operator's latest published policy row.
  WITH affected AS (
    SELECT DISTINCT
      p.invoice_id,
      i.bidder_id,
      i.operator_id,
      i.total_cents,
      COALESCE(op.no_show_policy, 'full_forfeit') AS no_show_policy,
      COALESCE(op.restock_fee_cents, 500) AS restock_fee_cents
    FROM pickups p
    JOIN invoices i ON i.id = p.invoice_id
    LEFT JOIN LATERAL (
      SELECT op_inner.no_show_policy, op_inner.restock_fee_cents
      FROM operator_policies op_inner
      WHERE op_inner.operator_id = i.operator_id
        AND op_inner.published = TRUE
      ORDER BY op_inner.version DESC
      LIMIT 1
    ) op ON TRUE
    WHERE p.status = 'no_show'
      AND p.updated_at >= now() - INTERVAL '5 minute'
  ),
  notifs AS (
    INSERT INTO notifications_outbox (kind, target_user_id, payload, idempotency_key)
    SELECT
      CASE a.no_show_policy
        WHEN 'refund_minus_restock' THEN 'pickup_no_show_refund_pending'::notification_kind
        ELSE 'pickup_no_show_forfeit'::notification_kind
      END,
      a.bidder_id,
      jsonb_build_object(
        'invoice_id', a.invoice_id,
        'policy', a.no_show_policy,
        'restock_fee_cents', a.restock_fee_cents,
        'total_cents', a.total_cents
      ),
      'no_show:' || a.invoice_id::text
    FROM affected a
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  )
  SELECT COUNT(*) INTO v_notify_count FROM notifs;

  -- PR-A2 Step 3b: emit operator_audit_log for each just-flipped no-show.
  -- action_type matches the documented values in mig 0157's header.
  WITH affected AS (
    SELECT DISTINCT
      p.invoice_id,
      i.bidder_id,
      i.operator_id,
      i.total_cents,
      COALESCE(op.no_show_policy, 'full_forfeit') AS no_show_policy,
      COALESCE(op.restock_fee_cents, 500) AS restock_fee_cents
    FROM pickups p
    JOIN invoices i ON i.id = p.invoice_id
    LEFT JOIN LATERAL (
      SELECT op_inner.no_show_policy, op_inner.restock_fee_cents
      FROM operator_policies op_inner
      WHERE op_inner.operator_id = i.operator_id
        AND op_inner.published = TRUE
      ORDER BY op_inner.version DESC
      LIMIT 1
    ) op ON TRUE
    WHERE p.status = 'no_show'
      AND p.updated_at >= now() - INTERVAL '5 minute'
  ),
  audit AS (
    INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, after_state, reason_note)
    SELECT
      a.operator_id,
      NULL,
      CASE a.no_show_policy
        WHEN 'refund_minus_restock' THEN 'no_show.refund_minus_restock'
        ELSE 'no_show.full_forfeit'
      END,
      a.invoice_id,
      jsonb_build_object(
        'invoice_id', a.invoice_id,
        'bidder_id', a.bidder_id,
        'policy', a.no_show_policy,
        'restock_fee_cents', a.restock_fee_cents,
        'total_cents', a.total_cents
      ),
      CASE a.no_show_policy
        WHEN 'refund_minus_restock' THEN
          'Refund worker not yet deployed — operator must issue refund manually via the (PR-C) refund flow once it ships.'
        ELSE
          'Full forfeiture — operator keeps payment, lot relisted.'
      END
    FROM affected a
    RETURNING id
  )
  SELECT COUNT(*) INTO v_audit_count FROM audit;

  RETURN jsonb_build_object(
    'pickups_flipped', v_pickup_count,
    'lots_routed_to_unsold', v_lot_count,
    'notifications_emitted', v_notify_count,
    'audit_log_entries', v_audit_count,
    'at', now()
  );
END;
$$;

COMMENT ON FUNCTION auto_mark_pickup_no_show() IS
  'Cron-driven no-show handler. As of PR-A2 (2026-05-29), in addition to the '
  'pickup → no_show + lot → unsold flips from mig 0155, this function now '
  'inserts notifications_outbox rows (bidder push) and operator_audit_log '
  'rows per affected invoice. The notification + audit kind branches on '
  'operator_policies.no_show_policy. Stripe refund issuance for the '
  'refund_minus_restock branch is DEFERRED to a follow-up PR with a refund '
  'job queue; for now the audit row notes "operator must issue manually".';
