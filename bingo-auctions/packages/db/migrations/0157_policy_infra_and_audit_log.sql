-- ============================================================================
-- 0157_policy_infra_and_audit_log.sql
--
-- PR-A1 of the operator-customizable post-win policy plan (2026-05-29).
-- See docs/state/PATCH-checkout-and-quicklot-fixes-2026-05-28.md for full plan
-- and the prep audit at docs/audits/pra1-prep-audit-2026-05-29.md.
--
-- THIS MIGRATION IS PURE ADDITIVE — ZERO money-flow behavior change on day 1.
-- Defaults match today's effective behavior. The behavior wiring (apply_relot_fee
-- reading from policy, auto_mark_pickup_no_show branching on policy,
-- auto-charge-drain reading the grace column) lands in PR-A2.
--
-- WHAT THIS DOES
--   1. Extends operator_policies with 4 new operator-configurable columns:
--        no_show_policy                  TEXT enum DEFAULT 'full_forfeit'
--        restock_fee_cents               INT  DEFAULT 500
--        relist_fee_cents                INT  DEFAULT 500
--        admin_can_refund_outside_window BOOL DEFAULT true
--      Defaults are intentionally behavior-preserving:
--        - 'full_forfeit' = today (operator keeps payment, lot relisted, no refund)
--        - 500 cents = today's hardcoded $5 in apply_relot_fee (mig 0105)
--        - true = today's advisory-only refund window (no server enforcement)
--   2. Creates operator_audit_log table (BIGSERIAL PK, append-only) mirroring
--      the pattern from 0098_audit_trail.sql. Will be written by future
--      refund_items RPC (PR-C), apply_relot_fee changes (PR-A2), and policy
--      edit captures from the Settings UI. RLS allows operator's manager+admin
--      to SELECT their own log; service_role + SECURITY DEFINER functions are
--      the only writers (no client INSERT policy).
--   3. Marks payment_window_hours as deprecated via COMMENT. Column is kept
--      because it is referenced in versioned policy docs that bidders have
--      already accepted (dropping invalidates historical acceptance). The UI
--      stops surfacing it (separate commit in PR-A1).
--   4. Re-defines seed_default_operator_policy() so new operators get the 4
--      new column values populated explicitly (matches the pattern from
--      0122_dispute_response_hours.sql).
-- ============================================================================

BEGIN;

-- ── 1. Add the 4 new columns to operator_policies (idempotent) ─────────────

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS no_show_policy TEXT NOT NULL DEFAULT 'full_forfeit'
    CHECK (no_show_policy IN ('full_forfeit', 'refund_minus_restock'));

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS restock_fee_cents INT NOT NULL DEFAULT 500
    CHECK (restock_fee_cents >= 0 AND restock_fee_cents <= 1000000);

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS relist_fee_cents INT NOT NULL DEFAULT 500
    CHECK (relist_fee_cents >= 0 AND relist_fee_cents <= 1000000);

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS admin_can_refund_outside_window BOOLEAN NOT NULL DEFAULT TRUE;

-- Column comments document intent for future readers and Supabase Studio.

COMMENT ON COLUMN public.operator_policies.no_show_policy IS
  'Behavior when a bidder fails to pick up by the window deadline. '
  '''full_forfeit'' (default): operator keeps the payment in full, lot relisted, '
  'no refund. ''refund_minus_restock'': operator refunds (winning_bid + premium + tax) '
  'minus restock_fee_cents, lot relisted. Per BidFTA-style legacy industry pattern, '
  'full_forfeit is the safer default. Operator can flip to refund_minus_restock '
  'via the Settings UI. Enforced by auto_mark_pickup_no_show cron in PR-A2.';

COMMENT ON COLUMN public.operator_policies.restock_fee_cents IS
  'Operator-set fee deducted from any refund (whether issued within '
  'refund_window_post_pickup_hours, by admin override outside the window, '
  'or via the no_show_policy=refund_minus_restock path). Cents; default 500 = $5. '
  'CHECK 0..1,000,000 caps at $10,000 to prevent fat-finger errors.';

COMMENT ON COLUMN public.operator_policies.relist_fee_cents IS
  'Operator-set fee charged to a bidder whose card declined and grace expired. '
  'Added to bidder_fee_ledger via apply_relot_fee (mig 0105). Replaces the '
  'hardcoded $5 default in that RPC (wiring lands in PR-A2). Cents; default 500. '
  'CHECK 0..1,000,000 caps at $10,000.';

COMMENT ON COLUMN public.operator_policies.admin_can_refund_outside_window IS
  'When TRUE, operator_users.role=''admin'' can approve refunds outside the '
  'refund_window_post_pickup_hours window (logged to operator_audit_log with '
  'reason_note). When FALSE, even admins are blocked outside the window. '
  'Default TRUE preserves today''s advisory-only behavior. Enforced by the '
  'refund_items RPC in PR-C.';

-- ── 2. Mark payment_window_hours as deprecated ─────────────────────────────
-- This column is "display-only" per the legacy audit — the schema exists and
-- bidders have accepted versioned policy docs referencing it, so we keep the
-- column. The UI (bidder + operator) stops surfacing it in a separate commit
-- of this PR.

COMMENT ON COLUMN public.operator_policies.payment_window_hours IS
  'DEPRECATED 2026-05-29 — display-only, NOT enforced. Auto-charge fires '
  'immediately at lot close per trigger_enqueue_auto_charge (mig 0105), '
  'ignoring this column. Kept in schema for historical policy-doc compatibility '
  '(bidders have accepted versioned docs referencing the column). UI no longer '
  'surfaces this field. Do not enforce in new code paths without an explicit '
  'product decision.';

-- ── 3. Create operator_audit_log table ─────────────────────────────────────
-- Mirrors 0098_audit_trail.sql pattern: BIGSERIAL PK (cheaper than UUID for
-- append-only logs), tenant-scoped via operator_id, RLS SELECT-only for
-- manager+admin of the owning operator. service_role + SECURITY DEFINER
-- functions are the only writers.
--
-- action_type values used by the system (extend as new audit-worthy events
-- are added):
--   'refund.items'                    — staff issues per-lot refund (PR-C)
--   'refund.admin_override'           — admin refunds outside window (PR-C)
--   'policy.edit'                     — operator admin edits operator_policies (PR-A1)
--   'no_show.relist_fee_applied'      — auto cron charges failed-charge bidder (PR-A2)
--   'no_show.full_forfeit'            — auto cron marks paid bidder forfeited (PR-A2)
--   'no_show.refund_minus_restock'    — auto cron refunds paid bidder w/ fee (PR-A2)

CREATE TABLE IF NOT EXISTS public.operator_audit_log (
  id BIGSERIAL PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  target_id UUID,
  before_state JSONB,
  after_state JSONB,
  reason_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.operator_audit_log IS
  'Append-only audit log of operator-scoped administrative actions. Written by '
  'service_role workers + SECURITY DEFINER RPCs. Readable by the operator''s '
  'admin + manager via RLS. Mirrors the lot/auction/invoice _history pattern '
  'from migration 0098.';

CREATE INDEX IF NOT EXISTS idx_operator_audit_log_operator_created
  ON public.operator_audit_log (operator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_audit_log_action_created
  ON public.operator_audit_log (action_type, created_at DESC);

ALTER TABLE public.operator_audit_log ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS; no INSERT/UPDATE/DELETE policy for clients.
-- This matches the auto_charge_jobs / notifications_outbox pattern.

DROP POLICY IF EXISTS operator_audit_log_read ON public.operator_audit_log;
CREATE POLICY operator_audit_log_read ON public.operator_audit_log
  FOR SELECT TO authenticated
  USING (
    operator_id = public.current_operator_id()
    AND public.current_operator_role() IN ('admin', 'manager')
  );

COMMENT ON POLICY operator_audit_log_read ON public.operator_audit_log IS
  'Operator''s admin + manager can read their own audit log. Pickers blocked. '
  'service_role bypasses RLS for write side. No client INSERT/UPDATE/DELETE.';

-- ── 4. Re-seed the trigger function with the 4 new columns ─────────────────
-- Body is byte-identical to migration 0122 except we append the new columns
-- to the column list and pass behavior-preserving defaults in VALUES. All
-- existing field wording (v_terms / v_refund / v_shipping) is preserved.

CREATE OR REPLACE FUNCTION public.seed_default_operator_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_terms TEXT;
  v_refund TEXT;
  v_shipping TEXT;
BEGIN
  v_terms :=
    '# Operator Terms' || E'\n\n' ||
    'By placing a bid on an auction operated by ' || COALESCE(NEW.business_name, 'this operator') || ', you agree to these terms in addition to the [ClovrBid Terms of Service](/legal/terms) and [Bidder Agreement](/legal/bidder-agreement).' || E'\n\n' ||
    '## Payment' || E'\n' ||
    'Payment is due immediately on winning. Your saved payment method will be charged at auction close.' || E'\n\n' ||
    '## Pickup window' || E'\n' ||
    'You have 7 days from auction close to pick up your won items.' || E'\n\n' ||
    '## Inspection' || E'\n' ||
    'You may inspect items at the pickup counter before accepting them. Pickup-counter refunds are issued for items that materially differ from the listing description.' || E'\n\n' ||
    '## After pickup — 48-hour dispute window' || E'\n' ||
    'Once items leave our warehouse with you, you have **48 hours from pickup** to open a dispute through the ClovrBid app if an item materially differs from what was described. After 48 hours, the sale is final per the platform [Bidder Agreement](/legal/bidder-agreement).' || E'\n\n' ||
    '## Suspension for non-payment / no-show' || E'\n' ||
    'Repeated payment failures or pickup no-shows may result in suspension from bidding with this operator.';

  v_refund :=
    '# Refund Policy' || E'\n\n' ||
    'Refunds are issued at the pickup counter for items that materially differ from the listing description, or that are damaged in a way not disclosed in the listing.' || E'\n\n' ||
    'To request a refund at the counter, decline the item at pickup and present it to the pickup attendant. We will issue a refund to your original payment method within 5 business days.' || E'\n\n' ||
    '## Post-pickup disputes (48 hours)' || E'\n' ||
    'If you accept an item at pickup and later discover it materially differs from what was described, you have **48 hours from pickup** to open a dispute through the ClovrBid app. Include photos and a short description. The operator will review and refund partially or in full at their discretion per the [Bidder Agreement](/legal/bidder-agreement).' || E'\n\n' ||
    'Disputes filed more than 48 hours after pickup are not eligible for refund.';

  v_shipping :=
    '# Shipping Policy' || E'\n\n' ||
    'This operator does not currently offer shipping. All items are pickup-only at our warehouse during posted pickup hours.';

  INSERT INTO operator_policies
    (operator_id, version, terms_md, refund_md, shipping_md,
     payment_window_hours, pickup_window_days, shipping_offered,
     refund_window_post_pickup_hours, dispute_response_hours,
     -- PR-A1 additions:
     no_show_policy, restock_fee_cents, relist_fee_cents,
     admin_can_refund_outside_window,
     published, content_hash, created_at)
  VALUES (
    NEW.id, 1, v_terms, v_refund, v_shipping,
    0, 7, FALSE, 48, 72,
    -- PR-A1: behavior-preserving defaults (today: keep payment, $5 fees, admin can override)
    'full_forfeit', 500, 500, TRUE,
    TRUE,
    encode(digest(v_terms || E'\n----\n' || v_refund || E'\n----\n' || v_shipping, 'sha256'), 'hex'),
    now()
  )
  ON CONFLICT (operator_id, version) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_default_operator_policy() IS
  'Seeds a default v1 published operator_policies row for newly-created '
  'operators. As of PR-A1 (2026-05-29), the seed also populates the 4 new '
  'operator-customizable post-win policy columns with behavior-preserving '
  'defaults: full_forfeit + $5 restock + $5 relist + admin override enabled.';

COMMIT;
