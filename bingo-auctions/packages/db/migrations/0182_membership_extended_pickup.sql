-- ============================================================================
-- 0182_membership_extended_pickup.sql — Membership perk 1: extended pickup
--
-- WHAT THIS MIGRATION DOES
--   CREATE OR REPLACE auto_mark_pickup_no_show — reproduces the ENTIRE body
--   from mig 0166 (Steps 1/2/3a/3b/3c + Step 4 forfeit escalation + audit +
--   RETURN) VERBATIM, with ONE additive change to the Step 1 `due` CTE:
--
--     • Two LEFT JOINs are added so the deadline can be bumped per-bidder by
--       the bidder's active operator-membership plan (mig 0177):
--         LEFT JOIN bidder_subscriptions bs
--           ON bs.bidder_id = i.bidder_id
--          AND bs.operator_id = i.operator_id
--          AND bs.status IN ('active','trialing')
--          AND (bs.current_period_end IS NULL OR bs.current_period_end > now())
--         LEFT JOIN operator_pro_plans p ON p.id = bs.plan_id
--
--     • The deadline expression gains ONE additive term:
--         + (COALESCE(p.extended_pickup_days, 0) * 24) * INTERVAL '1 hour'
--
--   This means a paid member at the invoice's operator gets
--   `extended_pickup_days` extra days of no-show/forfeit protection. A
--   free bidder (no sub, or sub with NULL plan) gets COALESCE → 0 → the
--   exact legacy deadline. NOTHING else in the function changes.
--
-- WHAT THIS MIGRATION DOES NOT DO  (🛑 DON'T-BREAK callouts, PLAN §7 Perk 1)
--   - Does NOT call my_active_pro_plan(): the cron runs in pg_cron context
--     with NO auth.uid(), so the helper would read NULL → empty. The plan is
--     resolved by INLINING the join keyed on the invoice's bidder_id.
--   - Does NOT write auctions.pickup_ends_at (shared by ALL winners of the
--     auction). The extension is a per-bidder DELTA computed inside the CTE,
--     never a row write.
--   - COALESCE-guards every new term (matches the existing
--     COALESCE(o.pickup_grace_extension_hours, 24) fallback).
--   - Only extends the no-show/forfeit deadline (the cron) per decision #2 —
--     slot booking (schedule_pickup / get_pickup_slots) is untouched.
--   - Does NOT change the pg_cron schedule (still */30 * * * * UTC; the
--     function is replaced in-place, the cron entry stays).
--   - Does NOT change Steps 2/3a/3b/3c/4, the audit insert, the RETURN
--     shape, the REVOKE, or the function COMMENT.
--
-- DEPENDENCY
--   Requires mig 0177 (operator_pro_plans + bidder_subscriptions.plan_id).
--
-- IDEMPOTENCY
--   - CREATE OR REPLACE FUNCTION — safe to re-run.
--   - pg_cron job is NOT re-registered.
-- ============================================================================

BEGIN;

-- ── CREATE OR REPLACE auto_mark_pickup_no_show ────────────────────────────────
-- Body below is copied VERBATIM from mig 0166. The ONLY changes are the two
-- LEFT JOINs and the one additive deadline term inside the Step 1 `due` CTE,
-- both annotated with "mig 0182:" below. NOTHING ELSE IS CHANGED.

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
          -- mig 0182: per-bidder membership extension (0 for free bidders).
          + (COALESCE(p.extended_pickup_days, 0) * 24) * INTERVAL '1 hour'
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
  --
  -- A no_show pickup is escalated to 'forfeited' when ALL of:
  --   (a) It was just flipped this tick (updated_at within 5-minute window).
  --   (b) The bidder has >= operators.no_show_forfeit_threshold no-show +
  --       forfeited pickups (combined) in the rolling 90-day window ending
  --       now. Counting both statuses means a bidder who already has
  --       forfeited pickups doesn't reset their count by falling back to
  --       no_show on a later tick.
  --   (c) The bidder has NOT had a pickup escalated to 'forfeited' within
  --       operators.forfeit_cooldown_days. If forfeit_cooldown_days = 0 the
  --       cooldown check is skipped entirely (CASE short-circuit).
  --
  -- Implementation notes:
  --   - We use a LATERAL subquery per affected pickup to compute the rolling
  --     count + cooldown check, scoped to the same operator, so each operator
  --     applies its own thresholds independently.
  --   - The update is gated on status = 'no_show' (not re-updating already
  --     forfeited rows) and the 5-minute updated_at window (same scope as
  --     Steps 3a–3c) so only this tick's flips are candidates.
  --   - We write a separate audit_log row for each forfeited pickup with
  --     action_type = 'no_show.forfeited' so operators can trace the escalation.
  --   - No new notification is emitted: the Step 3a 'pickup_no_show_forfeit'
  --     notification already covers this (sent before the escalation check).
  --     A follow-up PR (S15 E6) can add a second operator-facing alert.

  WITH just_flipped AS (
    -- Candidate pickups flipped this tick, scoped by 5-minute window.
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
    -- For each just-flipped pickup, compute whether the bidder has crossed
    -- the operator's no_show_forfeit_threshold in the rolling 90-day window,
    -- and whether they are outside the forfeit cooldown window.
    SELECT
      jf.pickup_id,
      jf.invoice_id,
      jf.bidder_id,
      jf.operator_id,
      COALESCE(o.no_show_forfeit_threshold, 3)   AS threshold,
      COALESCE(o.forfeit_cooldown_days, 30)       AS cooldown_days,
      -- Rolling 90-day count: no_show + forfeited pickups for this bidder
      -- at this operator, including the one just flipped.
      (
        SELECT COUNT(*)
        FROM pickups p2
        JOIN invoices i2 ON i2.id = p2.invoice_id
        WHERE i2.bidder_id  = jf.bidder_id
          AND i2.operator_id = jf.operator_id
          AND p2.status IN ('no_show', 'forfeited')
          AND p2.updated_at >= now() - INTERVAL '90 days'
      ) AS rolling_count,
      -- Most recent prior forfeiture (NULL if none) — for cooldown check.
      (
        SELECT MAX(p3.updated_at)
        FROM pickups p3
        JOIN invoices i3 ON i3.id = p3.invoice_id
        WHERE i3.bidder_id  = jf.bidder_id
          AND i3.operator_id = jf.operator_id
          AND p3.status = 'forfeited'
          AND p3.id <> jf.pickup_id   -- exclude the current one (not yet forfeited)
      ) AS last_forfeited_at
    FROM just_flipped jf
    JOIN operators o ON o.id = jf.operator_id
  ),
  eligible AS (
    -- Apply threshold + cooldown predicates.
    SELECT *
    FROM threshold_check
    WHERE rolling_count >= threshold
      AND (
        cooldown_days = 0                                          -- no cooldown
        OR last_forfeited_at IS NULL                               -- never forfeited
        OR last_forfeited_at < now() - (cooldown_days * INTERVAL '1 day')  -- outside window
      )
  ),
  forfeited AS (
    UPDATE pickups
       SET status = 'forfeited', updated_at = now()
     WHERE id IN (SELECT pickup_id FROM eligible)
       AND status = 'no_show'                                     -- idempotent guard
    RETURNING id, invoice_id
  )
  SELECT COUNT(*) INTO v_forfeited_count FROM forfeited;

  -- Audit log for each forfeited escalation.
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
    'forfeited_pickups',      v_forfeited_count,     -- mig 0166: new
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
  '0 and keep the legacy deadline. All other behavior is unchanged from mig '
  '0166: pickup → no_show + lot → unsold + notifications + audit_log + '
  'refund_jobs enqueue (Steps 1-3c) and Step 4 escalation of just-flipped '
  'no_show pickups to ''forfeited'' when the bidder has reached '
  'operators.no_show_forfeit_threshold no-show/forfeited pickups in the '
  'rolling 90-day window AND is outside the forfeit_cooldown_days window. '
  'Never writes auctions.pickup_ends_at — the membership extension is a '
  'per-bidder delta computed in the due CTE only.';

COMMIT;
