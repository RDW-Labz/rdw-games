-- 0233 — reseller tax exemption (resale certificate on file)
--
-- Owner, 2026-07-05: resellers (a big chunk of liquidation buyers) can buy
-- tax-exempt for resale in Arkansas when they hold a sales-tax permit and
-- the seller keeps an exemption certificate on file (AR form ST-391 /
-- permit number). Flow:
--
--   1. Bidder submits permit number + state + business name from /profile
--      (POST /api/bidder/resale-cert) → status 'pending'. Resubmitting
--      always drops tax_exempt back to false until re-approved.
--   2. Operator approves/rejects from the bidder detail page (admin/manager;
--      server action stamps reviewed_at). Approve sets tax_exempt = true.
--   3. build_invoices_for_auction (v3 below, previous live def = 0214)
--      zeroes tax_cents for exempt bidders. Applies to invoices built AFTER
--      approval — already-issued invoices are untouched.
--
-- The operator's audit duty: this table IS the certificate record (number,
-- state, business, who was approved when). Keep any paper ST-391s filed too.

BEGIN;

ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS resale_cert_permit TEXT;
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS resale_cert_state TEXT;
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS resale_cert_business TEXT;
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS resale_cert_status TEXT
  CHECK (resale_cert_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS resale_cert_submitted_at TIMESTAMPTZ;
ALTER TABLE public.bidders ADD COLUMN IF NOT EXISTS resale_cert_reviewed_at TIMESTAMPTZ;

-- ── build_invoices_for_auction v3: per-bidder tax exemption ─────────────────
-- Full replacement of the 0214 definition; the ONLY change is the
-- v_exempt lookup + its use in the v_tax CASE.
CREATE OR REPLACE FUNCTION public.build_invoices_for_auction(p_auction_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction record;
  v_operator record;
  v_bidder record;
  v_invoice_id uuid;
  v_buyer_premium int;
  v_exempt boolean;
  v_tax int;
  v_total int;
  v_app_fee int;
  v_count int := 0;
BEGIN
  SELECT id, buyer_premium_bps, operator_id
  INTO v_auction
  FROM public.auctions
  WHERE id = p_auction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auction_not_found: %', p_auction_id;
  END IF;

  SELECT id, application_fee_bps, collect_sales_tax, tax_rate_bps
  INTO v_operator
  FROM public.operators
  WHERE id = v_auction.operator_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_not_found: %', v_auction.operator_id;
  END IF;

  FOR v_bidder IN
    SELECT winner_bidder_id,
           SUM(current_bid_cents)::int AS subtotal
    FROM public.lots
    WHERE auction_id = p_auction_id
      AND status = 'won'
      AND winner_bidder_id IS NOT NULL
    GROUP BY winner_bidder_id
  LOOP
    v_buyer_premium := ROUND(v_bidder.subtotal::numeric * v_auction.buyer_premium_bps / 10000.0)::int;

    -- 0233: approved resale-certificate holders buy tax-free for resale.
    SELECT COALESCE(b.tax_exempt, false) INTO v_exempt
    FROM public.bidders b
    WHERE b.id = v_bidder.winner_bidder_id;

    -- 0214: flat sales tax on the full taxable price (subtotal + premium),
    -- gated on the operator's collect_sales_tax flag AND (0233) the
    -- bidder's exemption.
    v_tax := CASE
      WHEN COALESCE(v_operator.collect_sales_tax, false) AND NOT COALESCE(v_exempt, false)
        THEN ROUND((v_bidder.subtotal + v_buyer_premium)::numeric
                   * COALESCE(v_operator.tax_rate_bps, 0) / 10000.0)::int
      ELSE 0
    END;
    v_total := v_bidder.subtotal + v_buyer_premium + v_tax;
    v_app_fee := ROUND((v_bidder.subtotal + v_buyer_premium)::numeric * v_operator.application_fee_bps / 10000.0)::int;

    INSERT INTO public.invoices (
      operator_id, auction_id, bidder_id, status,
      subtotal_cents, buyer_premium_cents, tax_cents, total_cents, application_fee_cents
    ) VALUES (
      v_auction.operator_id, p_auction_id, v_bidder.winner_bidder_id, 'pending',
      v_bidder.subtotal, v_buyer_premium, v_tax, v_total, v_app_fee
    )
    ON CONFLICT (auction_id, bidder_id) DO UPDATE
      SET subtotal_cents = EXCLUDED.subtotal_cents,
          buyer_premium_cents = EXCLUDED.buyer_premium_cents,
          tax_cents = EXCLUDED.tax_cents,
          total_cents = EXCLUDED.total_cents,
          application_fee_cents = EXCLUDED.application_fee_cents
      WHERE public.invoices.status = 'pending'
    RETURNING id INTO v_invoice_id;

    -- If the upsert was a no-op (status != 'pending'), the RETURNING is NULL.
    -- Re-fetch so we can still rebuild invoice_lots for any pending invoice
    -- that just got refreshed.
    IF v_invoice_id IS NULL THEN
      SELECT id INTO v_invoice_id
      FROM public.invoices
      WHERE auction_id = p_auction_id AND bidder_id = v_bidder.winner_bidder_id;
    END IF;

    -- Only rebuild invoice_lots for a pending invoice. Paid/refunded
    -- invoices keep their historical line items.
    IF EXISTS (
      SELECT 1 FROM public.invoices
      WHERE id = v_invoice_id AND status = 'pending'
    ) THEN
      DELETE FROM public.invoice_lots WHERE invoice_id = v_invoice_id;
      INSERT INTO public.invoice_lots (invoice_id, lot_id, winning_bid_cents)
      SELECT v_invoice_id, l.id, l.current_bid_cents
      FROM public.lots l
      WHERE l.auction_id = p_auction_id
        AND l.status = 'won'
        AND l.winner_bidder_id = v_bidder.winner_bidder_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMIT;
