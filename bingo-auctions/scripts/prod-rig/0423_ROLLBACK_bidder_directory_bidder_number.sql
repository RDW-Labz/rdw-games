-- Rollback for 0423: restore 0247's operator_bidder_directory (no bidder_number).
-- The console tolerates a missing bidder_number (search by number just finds nothing).
BEGIN;

CREATE OR REPLACE FUNCTION public.operator_bidder_directory()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  result json;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.operator_users ou WHERE ou.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(json_agg(row_to_json(d) ORDER BY d.created_at DESC), '[]'::json)
  INTO result
  FROM (
    SELECT
      b.id,
      b.display_name,
      b.email,
      b.phone,
      b.created_at,
      (b.default_payment_method_id IS NOT NULL) AS has_card,
      b.marketing_emails_enabled,
      b.tax_exempt,
      -- 0247: resale-cert request review state, so the console can surface
      -- pending requests instead of hiding them inside each profile.
      b.resale_cert_status,
      b.resale_cert_submitted_at,
      b.referral_code,
      (b.referred_by IS NOT NULL) AS was_referred,
      (SELECT count(*) FROM public.bidders r
        WHERE r.referred_by = b.id AND r.deleted_at IS NULL)::int AS referred_count,
      coalesce((SELECT sum(c.amount_cents) FROM public.bidder_credits c
        WHERE c.bidder_id = b.id), 0)::int AS credit_balance_cents,
      (SELECT count(*) FROM public.bids bd WHERE bd.bidder_id = b.id)::int AS bids_total,
      (SELECT max(bd.placed_at) FROM public.bids bd WHERE bd.bidder_id = b.id) AS last_bid_at,
      (SELECT count(*) FROM public.invoices i
        WHERE i.bidder_id = b.id AND i.status::text = 'paid')::int AS invoices_paid,
      coalesce((SELECT sum(i.total_cents) FROM public.invoices i
        WHERE i.bidder_id = b.id AND i.status::text = 'paid'), 0)::int AS lifetime_spend_cents,
      coalesce((SELECT sum(i.total_cents) FROM public.invoices i
        WHERE i.bidder_id = b.id AND i.paid_at IS NULL
          AND i.status::text NOT IN ('refunded','canceled','void')), 0)::int AS unpaid_cents,
      EXISTS (SELECT 1 FROM public.operator_bidder_relations rel
        WHERE rel.bidder_id = b.id AND rel.suspended_at IS NOT NULL) AS suspended
    FROM public.bidders b
    WHERE b.deleted_at IS NULL
  ) d;

  RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.operator_bidder_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_bidder_directory() TO authenticated;

COMMIT;
