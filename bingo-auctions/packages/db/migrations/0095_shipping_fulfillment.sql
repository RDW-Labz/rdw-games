-- ============================================================================
-- Migration 0095 — Shipping fulfillment
--
-- Adds the schema for the second-mode-of-fulfillment work: operators can
-- now offer pickup, shipping, or both. Bidders pick at checkout (before
-- paying). ClovrBid holds one platform EasyPost account in v1 — the
-- per-operator EasyPost child-account hook is in the schema but unused
-- until v2.
--
-- Sections:
--   1. operators.offers_pickup / offers_shipping (capability flags)
--   2. operator_shipping_config (return address + default package dims)
--   3. invoices: fulfillment_method, shipping_address, shipping costs,
--      label URL, tracking number, carrier, shipped_at
--   4. fulfillment_method enum
--   5. RPC: set_invoice_fulfillment (bidder calls at checkout)
--
-- Idempotent throughout — IF NOT EXISTS / DO blocks / CREATE OR REPLACE.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 4. Fulfillment method enum (defined first; used by section 3)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_fulfillment_method') THEN
    CREATE TYPE invoice_fulfillment_method AS ENUM ('pickup', 'ship');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Operator capability flags
-- ---------------------------------------------------------------------------
-- Existing operators default to pickup=true / shipping=false to match the
-- platform's pre-0095 behaviour exactly. New operators can flip these in
-- the /settings/fulfillment UI. The CHECK constraint enforces that at
-- least one is true — an operator with neither has no way to fulfill
-- anything they sell.

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS offers_pickup BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS offers_shipping BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operators_at_least_one_fulfillment'
  ) THEN
    ALTER TABLE operators
      ADD CONSTRAINT operators_at_least_one_fulfillment
      CHECK (offers_pickup OR offers_shipping);
  END IF;
END $$;

COMMENT ON COLUMN operators.offers_pickup IS
  'When true, this operator supports in-warehouse pickup. Bidder checkout '
  'shows pickup as an option. Warehouses surface their pickup_mode setting. '
  'When false, the pickup mode column on warehouses is irrelevant and the '
  'setup hub hides the Pickup mode step.';

COMMENT ON COLUMN operators.offers_shipping IS
  'When true, this operator supports shipping to bidder addresses. Bidder '
  'checkout shows ship-to-me as an option. Operator must also configure '
  'operator_shipping_config (return address, package defaults) before any '
  'shipping invoice can be checked out.';

-- ---------------------------------------------------------------------------
-- 2. Operator shipping config
-- ---------------------------------------------------------------------------
-- One row per operator. Created lazily when the operator first enables
-- shipping. Contains the from-address used on every label and default
-- package weight/dims for rate quoting when the operator hasn't specified
-- per-lot dimensions (most won't, at least for v1).

CREATE TABLE IF NOT EXISTS operator_shipping_config (
  operator_id           UUID         PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,

  -- Return address. JSONB schema:
  --   { name, company, line1, line2, city, state, postal_code, country, phone }
  -- country defaults to 'US' in the API layer. Validated client-side and at
  -- label-purchase time by EasyPost address verification.
  return_address        JSONB        NOT NULL,

  -- Default package the operator ships in when an individual lot doesn't
  -- specify its own dims. Sane fallback for v1: a 12×9×3" 16oz box.
  default_pkg_weight_oz INTEGER      NOT NULL DEFAULT 16
                       CHECK (default_pkg_weight_oz > 0 AND default_pkg_weight_oz <= 1120),  -- 70 lb USPS max
  default_pkg_length_in NUMERIC(5,2) NOT NULL DEFAULT 12.0
                       CHECK (default_pkg_length_in > 0 AND default_pkg_length_in <= 108),
  default_pkg_width_in  NUMERIC(5,2) NOT NULL DEFAULT 9.0
                       CHECK (default_pkg_width_in > 0 AND default_pkg_width_in <= 108),
  default_pkg_height_in NUMERIC(5,2) NOT NULL DEFAULT 3.0
                       CHECK (default_pkg_height_in > 0 AND default_pkg_height_in <= 108),

  -- Flat fee added on top of the carrier rate to cover packaging/labor.
  -- Pure markup; doesn't flow to the carrier.
  handling_fee_cents    BIGINT       NOT NULL DEFAULT 0
                       CHECK (handling_fee_cents >= 0),

  -- Reserved for v2 — per-operator EasyPost child accounts. Until set,
  -- labels are bought through the ClovrBid platform account using the
  -- EASYPOST_API_KEY env var.
  easypost_account_token TEXT,

  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Auto-update updated_at on row change (uses the existing set_updated_at
-- function added in 0001_init.sql).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'operator_shipping_config_updated_at'
  ) THEN
    CREATE TRIGGER operator_shipping_config_updated_at
      BEFORE UPDATE ON operator_shipping_config
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE operator_shipping_config ENABLE ROW LEVEL SECURITY;

-- Operator staff read/write their own config. No public read.
DROP POLICY IF EXISTS operator_shipping_config_self_all ON operator_shipping_config;
CREATE POLICY operator_shipping_config_self_all
  ON operator_shipping_config FOR ALL
  USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());

-- ---------------------------------------------------------------------------
-- 3. Invoice shipping fields
-- ---------------------------------------------------------------------------
-- fulfillment_method is set by the bidder at checkout. Until set (i.e.,
-- the bidder is between winning and checking out) it stays NULL so we
-- can distinguish "not yet decided" from a real value.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS fulfillment_method invoice_fulfillment_method;

-- Snapshot of the bidder's chosen shipping address at checkout time.
-- We snapshot instead of foreign-keying to a separate address table
-- because addresses are immutable once a label is printed against them.
-- JSONB schema matches operator_shipping_config.return_address.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shipping_address JSONB;

-- Shipping cost line. Already collected from the bidder via Stripe at
-- checkout; the operator does not see this as part of operator_share.
-- ClovrBid keeps shipping_cents to cover the EasyPost label cost (plus
-- any handling fee markup goes to the operator separately if we wire it
-- through — for v1 the handling fee stays with the operator).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shipping_cents BIGINT NOT NULL DEFAULT 0
    CHECK (shipping_cents >= 0);

-- Label artifacts after purchase. shipping_label_url is a Supabase Storage
-- URL pointing to a PDF the operator downloads + prints. tracking_number
-- + carrier let the bidder follow the package via carrier tracking.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shipping_label_url TEXT;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shipping_tracking_number TEXT;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shipping_carrier TEXT;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shipping_label_purchased_at TIMESTAMPTZ;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- EasyPost references — we keep IDs so we can retry rate quotes,
-- re-fetch tracking, or void a label that hasn't been used yet.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS easypost_shipment_id TEXT;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS easypost_rate_id TEXT;

CREATE INDEX IF NOT EXISTS invoices_fulfillment_method_idx
  ON invoices(fulfillment_method)
  WHERE fulfillment_method IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_shipping_queue_idx
  ON invoices(operator_id, paid_at DESC)
  WHERE fulfillment_method = 'ship'
    AND status = 'paid'
    AND shipped_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. set_invoice_fulfillment RPC — called by bidder app at checkout
-- ---------------------------------------------------------------------------
-- The bidder app calls this after they pick "Pick up" or "Ship" on the
-- checkout screen. For ship, it also persists the address + shipping
-- cents quote. The PI is then created from the resulting invoice total.
--
-- Guards:
--   - caller is the invoice's bidder
--   - invoice is still 'pending' (no changing fulfillment after payment)
--   - if method='ship', operator must have offers_shipping=true and a
--     shipping_address must be supplied
--   - if method='pickup', operator must have offers_pickup=true

CREATE OR REPLACE FUNCTION set_invoice_fulfillment(
  p_invoice_id     UUID,
  p_method         TEXT,
  p_shipping_addr  JSONB,
  p_shipping_cents BIGINT,
  p_easypost_shipment_id TEXT DEFAULT NULL,
  p_easypost_rate_id     TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      UUID := auth.uid();
  v_invoice   invoices%ROWTYPE;
  v_offers_p  BOOLEAN;
  v_offers_s  BOOLEAN;
  v_method    invoice_fulfillment_method;
  v_new_total BIGINT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_found');
  END IF;
  IF v_invoice.bidder_id <> v_user THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_invoice_bidder');
  END IF;
  IF v_invoice.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_pending');
  END IF;

  -- Coerce + validate method
  BEGIN
    v_method := p_method::invoice_fulfillment_method;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_method');
  END;

  SELECT offers_pickup, offers_shipping
    INTO v_offers_p, v_offers_s
  FROM operators WHERE id = v_invoice.operator_id;

  IF v_method = 'pickup' AND NOT v_offers_p THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pickup_not_offered');
  END IF;

  IF v_method = 'ship' AND NOT v_offers_s THEN
    RETURN jsonb_build_object('ok', false, 'error', 'shipping_not_offered');
  END IF;

  IF v_method = 'ship' THEN
    IF p_shipping_addr IS NULL OR p_shipping_addr = 'null'::jsonb THEN
      RETURN jsonb_build_object('ok', false, 'error', 'shipping_address_required');
    END IF;
    IF p_shipping_cents IS NULL OR p_shipping_cents < 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_shipping_cents');
    END IF;
  END IF;

  -- Compute new total. Picking up sets shipping_cents to 0 (and clears
  -- any prior ship-quote state). Switching from ship → pickup is allowed
  -- while invoice is pending; the prior rate quote is forgotten.
  v_new_total := COALESCE(v_invoice.subtotal_cents, 0)
               + COALESCE(v_invoice.buyer_premium_cents, 0)
               + COALESCE(v_invoice.tax_cents, 0)
               + CASE WHEN v_method = 'ship' THEN COALESCE(p_shipping_cents, 0) ELSE 0 END;

  UPDATE invoices
  SET
    fulfillment_method = v_method,
    shipping_address   = CASE WHEN v_method = 'ship' THEN p_shipping_addr ELSE NULL END,
    shipping_cents     = CASE WHEN v_method = 'ship' THEN p_shipping_cents ELSE 0 END,
    easypost_shipment_id = CASE WHEN v_method = 'ship' THEN p_easypost_shipment_id ELSE NULL END,
    easypost_rate_id   = CASE WHEN v_method = 'ship' THEN p_easypost_rate_id ELSE NULL END,
    total_cents        = v_new_total,
    updated_at         = now()
  WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'ok', true,
    'method', v_method::text,
    'shipping_cents', CASE WHEN v_method = 'ship' THEN p_shipping_cents ELSE 0 END,
    'total_cents', v_new_total
  );
END;
$$;

REVOKE ALL ON FUNCTION set_invoice_fulfillment(UUID, TEXT, JSONB, BIGINT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_invoice_fulfillment(UUID, TEXT, JSONB, BIGINT, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: existing paid pickup-only invoices should have
-- fulfillment_method='pickup' so the new bidder/operator views don't
-- show them as "unfulfilled".
-- ---------------------------------------------------------------------------
UPDATE invoices
SET fulfillment_method = 'pickup'
WHERE fulfillment_method IS NULL
  AND status = 'paid';

COMMIT;
