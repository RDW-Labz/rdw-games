-- ============================================================================
-- 0159_refund_jobs.sql
--
-- PR-C of the operator-customizable post-win policy plan (2026-05-29).
-- Closes the gap left by PR-A2 (mig 0158): when no_show_policy =
-- 'refund_minus_restock', mig 0158 inserts the notification but does NOT issue
-- a Stripe refund. PR-C adds the refund_jobs queue + the SQL hook to enqueue
-- them; the actual Stripe call lives in a Node worker
-- (apps/operator-web/src/lib/cron/refund-jobs-drain.ts).
--
-- WHAT THIS MIGRATION DOES
--   1. ADD VALUE 'refund_completed' + 'refund_failed' to notification_kind.
--      Used by the worker to push bidder updates on refund lifecycle.
--   2. CREATE TYPE refund_reason — two-level enum (origin + sub_reason).
--   3. CREATE TABLE refund_jobs with RLS + indexes + unique partial constraint
--      that blocks duplicate no-show refund enqueues per invoice.
--   4. CREATE OR REPLACE FUNCTION claim_refund_job() — SECURITY DEFINER
--      atomic claim + FOR UPDATE SKIP LOCKED + attempt-bump wrapper that
--      supabase-js cannot do directly. Includes stale-lock recovery (anything
--      'processing' for >5 minutes is re-claimable).
--   5. CREATE OR REPLACE FUNCTION auto_mark_pickup_no_show() — copy of mig
--      0158's body with a NEW Step 3c that enqueues refund_jobs rows for
--      pickups whose operator policy is 'refund_minus_restock'.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - Does NOT call Stripe. The worker (Node) does that.
--   - Does NOT modify the existing /api/invoices/[id]/refund synchronous
--     route. That keeps working for in-window admin refunds.
--   - Does NOT consolidate the two refund paths — that's a follow-up.
--
-- action_type values added to operator_audit_log by PR-C code (extends mig
-- 0157's documented list — see header of 0157 for the canonical list):
--   'refund.items_requested'              — staff API insert
--   'refund.items_issued'                 — worker success (admin path)
--   'refund.no_show_minus_restock_issued' — worker success (cron path)
--   'refund.failed'                       — worker terminal failure
-- ============================================================================

BEGIN;

-- ── 1. New notification_kind enum values ──────────────────────────────────
-- Postgres rule: ALTER TYPE ADD VALUE allowed inside a transaction since PG
-- 12, BUT the new value cannot be USED in the same transaction. We only
-- reference these literals from app code (worker) — they're never used in
-- statements within this migration, so this is safe.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'refund_completed';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'refund_failed';

-- ── 2. refund_reason enum ──────────────────────────────────────────────────
-- Two-level model: origin (no_show_* / admin_*_refund) + sub_reason
-- (defective / wrong_item / damaged_in_transit / other). Both columns on the
-- same refund_jobs row; sub_reason is nullable (only admin path sets it).

CREATE TYPE refund_reason AS ENUM (
  'no_show_refund_minus_restock', -- cron-driven (mig 0158 no-show path)
  'admin_partial_refund',         -- staff-initiated single lot or sub-total
  'admin_full_refund',            -- staff-initiated entire invoice
  'defective_item',               -- staff sub-reason
  'wrong_item',                   -- staff sub-reason
  'damaged_in_transit',           -- staff sub-reason
  'other'                          -- staff free-text in reason_note
);

-- ── 3. refund_jobs table ──────────────────────────────────────────────────

CREATE TABLE public.refund_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id      UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  lot_id           UUID REFERENCES public.lots(id) ON DELETE SET NULL, -- NULL = whole-invoice
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  reason           refund_reason NOT NULL,
  sub_reason       refund_reason,                                       -- admin path only
  reason_note      TEXT,                                                -- free-text from staff or system

  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','succeeded','failed')),
  attempts         INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  stripe_refund_id TEXT UNIQUE,

  -- Lock columns for SKIP-LOCKED semantics via the SECURITY DEFINER claim
  -- wrapper (supabase-js can't issue FOR UPDATE SKIP LOCKED directly).
  locked_at        TIMESTAMPTZ,
  locked_by        TEXT,                                                -- worker invocation id

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL    -- NULL when system-created
);

CREATE INDEX idx_refund_jobs_pending
  ON public.refund_jobs (created_at ASC)
  WHERE status = 'pending';

CREATE INDEX idx_refund_jobs_processing_stale
  ON public.refund_jobs (locked_at)
  WHERE status = 'processing';

CREATE INDEX idx_refund_jobs_invoice
  ON public.refund_jobs (invoice_id);

-- Idempotency: at most one pending/processing/succeeded no-show-refund job
-- per invoice. The cron's 5-minute window scope + this partial unique index
-- prevents double-enqueue across cron ticks. 'failed' is excluded so a retry
-- can re-insert; the cron's updated_at filter still scopes which pickups are
-- considered.
CREATE UNIQUE INDEX uq_refund_jobs_no_show_per_invoice
  ON public.refund_jobs (invoice_id)
  WHERE reason = 'no_show_refund_minus_restock'
    AND status IN ('pending','processing','succeeded');

ALTER TABLE public.refund_jobs ENABLE ROW LEVEL SECURITY;

-- Read: operator admin+manager can see their own jobs. Pickers blocked.
DROP POLICY IF EXISTS refund_jobs_read ON public.refund_jobs;
CREATE POLICY refund_jobs_read ON public.refund_jobs
  FOR SELECT TO authenticated
  USING (
    operator_id = public.current_operator_id()
    AND public.current_operator_role() IN ('admin','manager')
  );

COMMENT ON POLICY refund_jobs_read ON public.refund_jobs IS
  'Operator admin + manager can read their own refund queue. Pickers blocked. '
  'service_role bypasses RLS for worker writes. No client INSERT/UPDATE/DELETE.';

-- No INSERT/UPDATE/DELETE policies — service_role + SECURITY DEFINER functions
-- only. Mirrors the operator_audit_log + auto_charge_jobs pattern.

COMMENT ON TABLE public.refund_jobs IS
  'Queue of pending Stripe refunds. Polled by the refund-jobs-drain cron '
  '(apps/operator-web/src/lib/cron/refund-jobs-drain.ts) every minute. Two '
  'producers: (1) auto_mark_pickup_no_show cron when policy='
  'refund_minus_restock, (2) /api/invoices/[id]/refund-items staff route. '
  'Worker calls stripe.refunds.create with reverse_transfer=true + '
  'refund_application_fee=true (destination-charge semantics) and writes the '
  'result back to status+stripe_refund_id. RLS allows operator admin/manager '
  'read; service_role only writer.';

-- ── 4. claim_refund_job — SECURITY DEFINER atomic claim wrapper ───────────
-- supabase-js cannot issue FOR UPDATE SKIP LOCKED, so we wrap. Returns the
-- claimed jobs as a SETOF with status flipped to 'processing', locked_at
-- stamped, attempts incremented. Stale-lock recovery: anything 'processing'
-- for >5min is re-claimable (Cloudflare Worker timeout is ~30s but we cushion
-- in case a chunked claim takes longer).

CREATE OR REPLACE FUNCTION public.claim_refund_job(
  p_worker_id TEXT,
  p_limit INT DEFAULT 10
)
RETURNS SETOF public.refund_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.refund_jobs SET
    status = 'processing',
    locked_at = now(),
    locked_by = p_worker_id,
    attempts = attempts + 1
  WHERE id IN (
    SELECT id FROM public.refund_jobs
    WHERE status = 'pending'
       OR (status = 'processing' AND locked_at < now() - INTERVAL '5 minute')
    ORDER BY created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_refund_job(TEXT, INT) FROM PUBLIC;

COMMENT ON FUNCTION public.claim_refund_job(TEXT, INT) IS
  'Atomic claim wrapper for the refund-jobs-drain worker. Selects up to '
  'p_limit oldest pending (or stale-processing >5min) rows, flips them to '
  '''processing'', stamps locked_at/locked_by, bumps attempts, and returns '
  'them. Uses FOR UPDATE SKIP LOCKED to allow concurrent worker invocations '
  'without overlap. Stale-lock recovery handles Worker timeouts mid-flight.';

-- ── 5. CREATE OR REPLACE auto_mark_pickup_no_show — add Step 3c ───────────
-- Body is copied verbatim from mig 0158 with one addition:
--   - Step 3c: enqueue refund_jobs rows for refund_minus_restock pickups
--     (amount = total_cents - restock_fee_cents, bounded > 0).
-- All other behavior preserved exactly:
--   - advisory lock, pickup → no_show flip, lot → unsold routing,
--     notifications_outbox emit (Step 3a), operator_audit_log emit (Step 3b).
-- The reason_note text for refund_minus_restock in Step 3b is updated to
-- reference the queued worker (replaces the "manual" note from mig 0158).

CREATE OR REPLACE FUNCTION public.auto_mark_pickup_no_show()
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
  v_refund_jobs_enqueued INT := 0;
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

  -- Step 3a: emit notifications_outbox for each just-flipped no-show.
  -- (mig 0158 body — preserved verbatim)
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

  -- Step 3b: emit operator_audit_log for each just-flipped no-show.
  -- (mig 0158 body — preserved verbatim except for reason_note text update:
  -- the refund_minus_restock branch now points to the queued worker, not a
  -- manual operator step.)
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

  -- PR-C Step 3c: enqueue refund_jobs for refund_minus_restock no-shows.
  -- Amount = total_cents - restock_fee_cents, bounded > 0 (skip $0/negative).
  -- The unique partial index uq_refund_jobs_no_show_per_invoice blocks
  -- double-insert across cron ticks (already pending/processing/succeeded
  -- rows are conflicts → no-op).
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

  RETURN jsonb_build_object(
    'pickups_flipped',        v_pickup_count,
    'lots_routed_to_unsold',  v_lot_count,
    'notifications_emitted',  v_notify_count,
    'audit_log_entries',      v_audit_count,
    'refund_jobs_enqueued',   v_refund_jobs_enqueued,
    'at',                     now()
  );
END;
$$;

COMMENT ON FUNCTION public.auto_mark_pickup_no_show() IS
  'Cron-driven no-show handler. As of PR-C (mig 0159, 2026-05-29), in '
  'addition to the pickup -> no_show + lot -> unsold flips + notifications + '
  'audit log from PR-A2 (mig 0158), this function now also enqueues a '
  'refund_jobs row when policy=refund_minus_restock so the Node worker can '
  'issue a Stripe refund of total minus restock fee. Per-invoice uniqueness '
  'is enforced by uq_refund_jobs_no_show_per_invoice.';

COMMIT;
