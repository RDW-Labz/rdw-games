-- ============================================================================
-- Migration 0474 — manager refund override for invoices Square cannot refund.
--
-- Why (2026-10-27, Jared): at checkout staff could not refund TEA3828564 and
-- were told only "no_payment_to_refund". That case (a credit-paid invoice) is
-- fixed in the app routes (store credit goes back, no Square call). What is
-- left is an invoice settled OFFLINE (cash/check at the counter, or marked
-- paid by hand): Square holds no payment, so nothing can go back through it.
-- Prod 90 days to 2026-10-27: 4 such invoices; 29 more were credit-paid.
--
-- New:
--   refund_override_settings      per operator: per-use cap, daily cap
--                                 (defaults $25 / $100 when no row)
--   refund_overrides              one row per use; the report reads it
--   record_refund_override(invoice, lot, amount, method, staff_name, reason, cause)
--     Manager/admin only. Typed staff name and reason required (logins are
--     shared). method 'cash' (handed from the drawer) or 'store_credit'
--     (account credit). Refused when:
--       - the invoice has a card payment (Square or legacy Stripe): card
--         refunds always go through Square, never around it;
--       - the line is not on the invoice, already refunded or forfeited;
--       - the amount is more than the line was paid (hammer + its share of
--         premium and tax) or than is left on the invoice;
--       - cash is more than was paid offline (credit-paid money only goes
--         back as credit);
--       - the amount is over the per-use cap, or would take today's
--         (America/Chicago) total over the daily cap.
--     Writes the refund the same way the refund routes do (invoice refunded
--     cents + status, line refunded_at, credit row for store credit) plus a
--     refund_overrides row and operator_audit_log 'invoice.refund_override'.
--   refund_override_settings_set(per_use, daily, staff_name)  admin only.
--
-- No change to lots, bids or invoices tables (no ALTER); two new small tables.
-- Locks: catalog only. Any hour outside 18:00-22:00 CT.
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE.
-- Rollback: scripts/prod-rig/0474_ROLLBACK_refund_override.sql
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.refund_override_settings (
  operator_id        UUID PRIMARY KEY REFERENCES public.operators(id) ON DELETE CASCADE,
  per_use_max_cents  INT NOT NULL DEFAULT 2500 CHECK (per_use_max_cents BETWEEN 0 AND 100000),
  daily_max_cents    INT NOT NULL DEFAULT 10000 CHECK (daily_max_cents BETWEEN 0 AND 500000),
  updated_by_name    TEXT,
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.refund_override_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_override_settings FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.refund_overrides (
  id            BIGSERIAL PRIMARY KEY,
  operator_id   UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  invoice_id    UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  lot_id        UUID NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  amount_cents  INT NOT NULL CHECK (amount_cents > 0),
  method        TEXT NOT NULL CHECK (method IN ('cash', 'store_credit')),
  staff_name    TEXT NOT NULL CHECK (btrim(staff_name) <> ''),
  reason        TEXT NOT NULL CHECK (btrim(reason) <> ''),
  cause         TEXT,
  line_paid_cents INT NOT NULL,
  actor_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_overrides_operator_day_idx
  ON public.refund_overrides (operator_id, created_at DESC);
ALTER TABLE public.refund_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_overrides FROM anon, authenticated;

COMMENT ON TABLE public.refund_overrides IS
  '0474: manager refund overrides (offline-paid invoices Square cannot refund). '
  'Server-only; the console report reads it with the service role.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_refund_override(
  p_invoice_id    UUID,
  p_lot_id        UUID,
  p_amount_cents  INT,
  p_method        TEXT,
  p_staff_name    TEXT,
  p_reason        TEXT,
  p_cause         TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_name       TEXT := nullif(btrim(coalesce(p_staff_name, '')), '');
  v_why        TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_role       TEXT;
  v_inv        invoices%ROWTYPE;
  v_line       invoice_lots%ROWTYPE;
  v_line_paid  INT;
  v_remaining  INT;
  v_cash_left  INT;
  v_per_use    INT;
  v_daily      INT;
  v_today      INT;
  v_tax        INT;
  v_cash       INT := 0;
  v_credit     INT := 0;
  v_new_cash   INT;
  v_new_credit INT;
  v_id         BIGINT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'staff_name_required');
  END IF;
  IF v_why IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'store_credit') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_method');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_amount');
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT role INTO v_role FROM operator_users WHERE user_id = v_uid AND operator_id = v_inv.operator_id LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'manager_only');
  END IF;
  IF v_inv.status = 'refunded' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invoice_already_refunded');
  END IF;
  IF v_inv.status NOT IN ('paid', 'partially_refunded') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_paid', 'status', v_inv.status);
  END IF;
  -- Never around Square: a card payment is refunded through Square only.
  IF v_inv.square_payment_id IS NOT NULL OR v_inv.stripe_charge_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'use_card_refund');
  END IF;

  SELECT * INTO v_line FROM invoice_lots WHERE invoice_id = p_invoice_id AND lot_id = p_lot_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_in_invoice');
  END IF;
  IF v_line.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_already_refunded');
  END IF;
  IF v_line.forfeited_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_forfeited');
  END IF;

  -- What this line was paid: hammer + its share of premium and tax (same
  -- formula as lib/refund-math computeLotFullRefundableCents).
  IF coalesce(v_inv.subtotal_cents, 0) <= 0 THEN
    v_line_paid := v_line.winning_bid_cents;
  ELSE
    v_line_paid := v_line.winning_bid_cents
      + round(coalesce(v_inv.buyer_premium_cents, 0)::numeric * v_line.winning_bid_cents / v_inv.subtotal_cents)::int
      + round(coalesce(v_inv.tax_cents, 0)::numeric * v_line.winning_bid_cents / v_inv.subtotal_cents)::int;
  END IF;
  v_remaining := greatest(0, coalesce(v_inv.total_cents, 0) - coalesce(v_inv.refunded_cash_cents, 0) - coalesce(v_inv.refunded_credit_cents, 0));
  IF p_amount_cents > least(v_line_paid, v_remaining) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'over_line_paid',
                              'line_paid_cents', v_line_paid, 'remaining_cents', v_remaining);
  END IF;
  -- Paid offline = total - credit applied. Cash only from that; credit-paid
  -- money only goes back as credit.
  v_cash_left := greatest(0, coalesce(v_inv.total_cents, 0) - coalesce(v_inv.credit_applied_cents, 0) - coalesce(v_inv.refunded_cash_cents, 0));
  IF p_method = 'cash' AND p_amount_cents > v_cash_left THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cash_over_paid_offline', 'cash_left_cents', v_cash_left);
  END IF;

  SELECT coalesce(s.per_use_max_cents, 2500), coalesce(s.daily_max_cents, 10000)
    INTO v_per_use, v_daily
    FROM (SELECT 1) one LEFT JOIN refund_override_settings s ON s.operator_id = v_inv.operator_id;
  IF p_amount_cents > v_per_use THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'over_per_use_cap', 'cap_cents', v_per_use);
  END IF;
  -- Serialise overrides per operator so two at once cannot both fit the cap.
  PERFORM pg_advisory_xact_lock(hashtextextended('refund_override:' || v_inv.operator_id::text, 0));
  SELECT coalesce(sum(amount_cents), 0) INTO v_today
    FROM refund_overrides
   WHERE operator_id = v_inv.operator_id
     AND created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago');
  IF v_today + p_amount_cents > v_daily THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'over_daily_cap', 'cap_cents', v_daily, 'used_today_cents', v_today);
  END IF;

  IF p_method = 'cash' THEN v_cash := p_amount_cents; ELSE v_credit := p_amount_cents; END IF;
  v_new_cash := coalesce(v_inv.refunded_cash_cents, 0) + v_cash;
  v_new_credit := coalesce(v_inv.refunded_credit_cents, 0) + v_credit;
  v_tax := CASE WHEN coalesce(v_inv.total_cents, 0) > 0
                THEN round(p_amount_cents::numeric * coalesce(v_inv.tax_cents, 0) / v_inv.total_cents)::int ELSE 0 END;

  IF v_credit > 0 THEN
    INSERT INTO bidder_credits (bidder_id, amount_cents, reason, invoice_id)
    VALUES (v_inv.bidder_id, v_credit, 'refund_return', v_inv.id);
  END IF;

  UPDATE invoices
     SET refunded_cash_cents   = v_new_cash,
         refunded_credit_cents = v_new_credit,
         refunded_tax_cents    = coalesce(refunded_tax_cents, 0) + v_tax,
         status                = CASE WHEN v_new_cash + v_new_credit >= coalesce(total_cents, 0)
                                      THEN 'refunded'::invoice_status ELSE 'partially_refunded'::invoice_status END,
         refunded_at           = coalesce(refunded_at, now()),
         updated_at            = now()
   WHERE id = v_inv.id;

  UPDATE invoice_lots SET refunded_at = now()
   WHERE invoice_id = v_inv.id AND lot_id = p_lot_id AND refunded_at IS NULL;

  INSERT INTO refund_overrides (operator_id, invoice_id, lot_id, amount_cents, method, staff_name, reason, cause, line_paid_cents, actor_id)
  VALUES (v_inv.operator_id, v_inv.id, p_lot_id, p_amount_cents, p_method, v_name, v_why, nullif(btrim(coalesce(p_cause, '')), ''), v_line_paid, v_uid)
  RETURNING id INTO v_id;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_inv.operator_id, v_uid, 'invoice.refund_override', v_inv.id,
          jsonb_build_object('status', v_inv.status, 'refunded_cash_cents', v_inv.refunded_cash_cents,
                             'refunded_credit_cents', v_inv.refunded_credit_cents),
          jsonb_build_object('lot_id', p_lot_id, 'amount_cents', p_amount_cents, 'method', p_method,
                             'staff_name', v_name, 'cause', p_cause, 'line_paid_cents', v_line_paid,
                             'override_id', v_id),
          v_why);

  RETURN jsonb_build_object('ok', true, 'reason', 'ok_recorded', 'override_id', v_id,
                            'amount_cents', p_amount_cents, 'method', p_method,
                            'line_paid_cents', v_line_paid, 'used_today_cents', v_today + p_amount_cents,
                            'daily_cap_cents', v_daily);
END;
$$;

REVOKE ALL ON FUNCTION public.record_refund_override(UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_refund_override(UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_refund_override(UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_override_settings_set(
  p_per_use_max_cents INT,
  p_daily_max_cents   INT,
  p_staff_name        TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_op   UUID;
  v_role TEXT;
  v_name TEXT := nullif(btrim(coalesce(p_staff_name, '')), '');
BEGIN
  SELECT operator_id, role INTO v_op, v_role FROM operator_users WHERE user_id = v_uid LIMIT 1;
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admin_only');
  END IF;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'staff_name_required');
  END IF;
  IF p_per_use_max_cents IS NULL OR p_daily_max_cents IS NULL
     OR p_per_use_max_cents < 0 OR p_daily_max_cents < p_per_use_max_cents
     OR p_per_use_max_cents > 100000 OR p_daily_max_cents > 500000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_caps');
  END IF;
  INSERT INTO refund_override_settings (operator_id, per_use_max_cents, daily_max_cents, updated_by_name, updated_by, updated_at)
  VALUES (v_op, p_per_use_max_cents, p_daily_max_cents, v_name, v_uid, now())
  ON CONFLICT (operator_id) DO UPDATE
     SET per_use_max_cents = EXCLUDED.per_use_max_cents, daily_max_cents = EXCLUDED.daily_max_cents,
         updated_by_name = EXCLUDED.updated_by_name, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, after_state, reason_note)
  VALUES (v_op, v_uid, 'refund_override.settings', v_op,
          jsonb_build_object('per_use_max_cents', p_per_use_max_cents, 'daily_max_cents', p_daily_max_cents, 'staff_name', v_name),
          NULL);
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_override_settings_set(INT, INT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_override_settings_set(INT, INT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.refund_override_settings_set(INT, INT, TEXT) TO authenticated, service_role;

COMMIT;
