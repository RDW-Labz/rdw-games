-- 0214 — flat sales tax at invoice build (launch blocker, tester 2026-07-02)
--
-- Every BinGo sale is picked up in person at the warehouse, so the tax situs
-- is a single location and one combined rate applies: Harrison, AR = 9.50%
-- (6.5% state + 1.25% Boone County + 1.75% city, verified 2026-07-03).
--
-- Design: `operators.tax_rate_bps` (0..2000) + the existing
-- `operators.collect_sales_tax` gate (0113). build_invoices_for_auction
-- (0072, still the live definition) now computes
--   tax_cents = ROUND((subtotal + buyer_premium) * tax_rate_bps / 10000)
-- when collect_sales_tax is true. Buyer's premium is part of the taxable
-- sales price in Arkansas. Everything downstream already handles a non-zero
-- tax_cents: total_cents feeds the Square charge (auto-charge-drain), and all
-- three receipt UIs render the Tax row conditionally on tax_cents > 0.
--
-- Rollback = UPDATE operators SET collect_sales_tax = false (tax_cents goes
-- back to 0 on the next pending-invoice rebuild; paid invoices are immutable).

BEGIN;

ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS tax_rate_bps INT NOT NULL DEFAULT 0
    CHECK (tax_rate_bps BETWEEN 0 AND 2000);

COMMENT ON COLUMN public.operators.tax_rate_bps IS
  '0214: flat combined sales-tax rate in basis points (950 = 9.50%), applied '
  'to subtotal + buyer premium at invoice build when collect_sales_tax is '
  'true. Correct for single-location in-person pickup (tax situs = the '
  'warehouse). A future multi-warehouse operator needs per-warehouse rates.';

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
    -- 0214: flat sales tax on the full taxable price (subtotal + premium),
    -- gated on the operator's collect_sales_tax flag.
    v_tax := CASE
      WHEN COALESCE(v_operator.collect_sales_tax, false)
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

-- BinGo (single live operator): Harrison AR combined rate, collection ON.
UPDATE public.operators
SET tax_rate_bps = 950,
    collect_sales_tax = true
WHERE code = 'BIN';

COMMIT;
