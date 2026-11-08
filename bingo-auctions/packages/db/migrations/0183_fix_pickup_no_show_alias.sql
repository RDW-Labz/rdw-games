-- ============================================================================
-- 0183_fix_pickup_no_show_alias.sql — HOTFIX for mig 0182 runtime error
--
-- WHAT WENT WRONG
--   Mig 0182 added a LEFT JOIN aliased `opp` (operator_pro_plans) to the Step 1
--   `due` CTE of auto_mark_pickup_no_show(), but the new deadline term
--   referenced the column as `p.extended_pickup_days`. In that CTE `p` is the
--   `pickups` table (FROM pickups p), which has no such column. plpgsql defers
--   planning of embedded SQL until first execution, so CREATE OR REPLACE
--   (and the schema-migrations CI) succeeded, but every pg_cron tick of
--   `auto-mark-pickup-no-show` (jobid 10) failed at runtime with:
--       ERROR: column p.extended_pickup_days does not exist
--       HINT:  Perhaps you meant to reference the column "opp.extended_pickup_days".
--   First failure 2026-06-04 01:30 UTC (Sentry), immediately after 0182 applied.
--
-- WHAT THIS MIGRATION DOES
--   CREATE OR REPLACE auto_mark_pickup_no_show() with the body from 0182
--   VERBATIM, changing EXACTLY ONE token: the Step 1 deadline term now reads
--   `opp.extended_pickup_days` (the operator_pro_plans alias) instead of
--   `p.extended_pickup_days`. Nothing else changes.
--
-- IDEMPOTENCY
--   CREATE OR REPLACE FUNCTION — safe to re-run. pg_cron job not re-registered.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.auto_mark_pickup_no_show()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pickup_count         INT := 0;
  v_lot_count            INT := 0;
  v_notify_count         INT := 0;
  v_audit_count          INT := 0;
  v_refund_jobs_enqueued INT := 0;
  v_forfeited_count      INT := 0;   -- mig 0166: new
BEGIN
  IF NOT pg_try_advisory_xact_lock(7423940155) THEN
    RETURN jsonb_build_object('skipped', 'lock_held');
  END IF;

  -- ── Step 1: find pickups past deadline (with operator's grace extension). ──
  -- (preserved verbatim from mig 0159/0166, except the two membership LEFT
  --  JOINs + the per-bidder deadline term annotated "mig 0182:" below.)
  WITH due AS (
    SELECT p.id AS pickup_id, p.invoice_id
    FROM pickups p
    JOIN invoices  i ON i.id = p.invoice_id
    JOIN auctions  a ON a.id = i.auction_id
    JOIN operators o ON o.id = i.operator_id
    -- mig 0182: resolve the invoice bidder's active membership plan (if any)
    -- INLINE — no auth.uid() in pg_cron. Keyed on the invoice's bidder_id +
    -- operator_id; only active/trialing + unexpired subs count.
    LEFT JOIN bidder_subscriptions bs
           ON bs.bidder_id = i.bidder_id
          AND bs.operator_id = i.operator_id
          AND bs.status IN ('active', 'trialing')
          AND (bs.current_period_end IS NULL OR bs.current_period_end > now())
    LEFT JOIN operator_pro_plans opp ON opp.id = bs.plan_id
    WHERE p.status IN ('pending', 'scheduled')
      AND (
        COALESCE(p.scheduled_at, a.pickup_ends_at)
          + (COALESCE(o.pickup_grace_extension_hours, 24) * INTERVAL '1 hour')
          -- mig 0182 (fixed in 0183): per-bidder membership extension (0 for
          -- free bidders). Reads the operator_pro_plans alias `opp`, NOT `p`
          -- (which is the pickups table and has no extended_pickup_days column).
          + (COALESCE(opp.extended_pickup_days, 0) * 24) * INTERVAL '1 hour'
      ) < now()
  ),
  flipped AS (
    UPDATE pickups
       SET status = 'no_show', updated_at = now()
     WHERE id IN (SELECT pickup_id FROM due)
    RETURNING id, invoice_id
  )
  SELECT COUNT(*) INTO v_pickup_count FROM flipped;

  -- ── Step 2: route affected lots to 'unsold'. ──────────────────────────────
  -- (preserved verbatim from mig 0159)
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

  -- ── Step 3a: emit notifications_outbox for each just-flipped no-show. ─────
  -- (preserved verbatim from mig 0159)
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

  -- ── Step 3b: emit operator_audit_log for each just-flipped no-show. ───────
  -- (preserved verbatim from mig 0159)
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
          'Refund job enqueued (refund_jobs queue) — worker will issue Stripe refund of total minus restock fee.'
        ELSE
          'Full forfeiture — operator keeps payment, lot relisted.'
      END
    FROM affected a
    RETURNING id
  )
  SELECT COUNT(*) INTO v_audit_count FROM audit;

  -- ── Step 3c: enqueue refund_jobs for refund_minus_restock no-shows. ────────
  -- (preserved verbatim from mig 0159)
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
      AND COALESCE(op.no_show_policy, 'full_forfeit') = 'refund_minus_restock'
  ),
  enqueued AS (
    INSERT INTO refund_jobs (
      operator_id, invoice_id, lot_id, amount_cents,
      reason, reason_note, status, created_by
    )
    SELECT
      a.operator_id,
      a.invoice_id,
      NULL,                                                  -- whole-invoice
      GREATEST(a.total_cents - a.restock_fee_cents, 0),
      'no_show_refund_minus_restock',
      'Auto-issued by no-show cron. Restock fee withheld per operator policy.',
      'pending',
      NULL                                                   -- system-created
    FROM affected a
    WHERE a.total_cents > a.restock_fee_cents                -- skip $0 refunds
    ON CONFLICT DO NOTHING
    RETURNING id
  )
  SELECT COUNT(*) INTO v_refund_jobs_enqueued FROM enqueued;

  -- ── Step 4: escalate qualifying no_show pickups to 'forfeited'. ─────────────
  -- (mig 0166 — ADDITIVE, all prior steps untouched)
  WITH just_flipped AS (
    SELECT
      p.id           AS pickup_id,
      p.invoice_id,
      i.bidder_id,
      i.operator_id
    FROM pickups p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.status = 'no_show'
      AND p.updated_at >= now() - INTERVAL '5 minute'
  ),
  threshold_check AS (
    SELECT
      jf.pickup_id,
      jf.invoice_id,
      jf.bidder_id,
      jf.operator_id,
      COALESCE(o.no_show_forfeit_threshold, 3)   AS threshold,
      COALESCE(o.forfeit_cooldown_days, 30)       AS cooldown_days,
      (
        SELECT COUNT(*)
        FROM pickups p2
        JOIN invoices i2 ON i2.id = p2.invoice_id
        WHERE i2.bidder_id  = jf.bidder_id
          AND i2.operator_id = jf.operator_id
          AND p2.status IN ('no_show', 'forfeited')
          AND p2.updated_at >= now() - INTERVAL '90 days'
      ) AS rolling_count,
      (
        SELECT MAX(p3.updated_at)
        FROM pickups p3
        JOIN invoices i3 ON i3.id = p3.invoice_id
        WHERE i3.bidder_id  = jf.bidder_id
          AND i3.operator_id = jf.operator_id
          AND p3.status = 'forfeited'
          AND p3.id <> jf.pickup_id
      ) AS last_forfeited_at
    FROM just_flipped jf
    JOIN operators o ON o.id = jf.operator_id
  ),
  eligible AS (
    SELECT *
    FROM threshold_check
    WHERE rolling_count >= threshold
      AND (
        cooldown_days = 0
        OR last_forfeited_at IS NULL
        OR last_forfeited_at < now() - (cooldown_days * INTERVAL '1 day')
      )
  ),
  forfeited AS (
    UPDATE pickups
       SET status = 'forfeited', updated_at = now()
     WHERE id IN (SELECT pickup_id FROM eligible)
       AND status = 'no_show'
    RETURNING id, invoice_id
  )
  SELECT COUNT(*) INTO v_forfeited_count FROM forfeited;

  WITH just_forfeited AS (
    SELECT
      p.id           AS pickup_id,
      p.invoice_id,
      i.bidder_id,
      i.operator_id
    FROM pickups p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.status = 'forfeited'
      AND p.updated_at >= now() - INTERVAL '5 minute'
  )
  INSERT INTO operator_audit_log (
    operator_id, actor_user_id, action_type, target_id, after_state, reason_note
  )
  SELECT
    jf.operator_id,
    NULL,
    'no_show.forfeited',
    jf.invoice_id,
    jsonb_build_object(
      'pickup_id',  jf.pickup_id,
      'invoice_id', jf.invoice_id,
      'bidder_id',  jf.bidder_id
    ),
    'Pickup automatically escalated from no_show to forfeited: bidder reached no_show_forfeit_threshold within rolling 90-day window.'
  FROM just_forfeited jf
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'pickups_flipped',        v_pickup_count,
    'lots_routed_to_unsold',  v_lot_count,
    'notifications_emitted',  v_notify_count,
    'audit_log_entries',      v_audit_count,
    'refund_jobs_enqueued',   v_refund_jobs_enqueued,
    'forfeited_pickups',      v_forfeited_count,
    'at',                     now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auto_mark_pickup_no_show() FROM PUBLIC;

COMMENT ON FUNCTION public.auto_mark_pickup_no_show() IS
  'Cron-driven no-show handler. As of mig 0182 (2026-06-03), the Step 1 '
  'deadline is extended per-bidder by the invoice bidder''s active operator-'
  'membership plan (operator_pro_plans.extended_pickup_days, joined INLINE on '
  'the invoice''s bidder_id — no auth.uid() in cron). Free bidders COALESCE to '
  '0 and keep the legacy deadline. mig 0183 fixed a runtime error where the '
  'extension term referenced the pickups alias (p) instead of the '
  'operator_pro_plans alias (opp). All other behavior is unchanged from mig '
  '0166: pickup → no_show + lot → unsold + notifications + audit_log + '
  'refund_jobs enqueue (Steps 1-3c) and Step 4 escalation of just-flipped '
  'no_show pickups to ''forfeited'' when the bidder has reached '
  'operators.no_show_forfeit_threshold no-show/forfeited pickups in the '
  'rolling 90-day window AND is outside the forfeit_cooldown_days window. '
  'Never writes auctions.pickup_ends_at — the membership extension is a '
  'per-bidder delta computed in the due CTE only.';

COMMIT;
