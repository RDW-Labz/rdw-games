-- 0235 — operator_bidder_directory(): the full customer directory RPC
--
-- Owner, 2026-07-06: "i dont have access to customer info or anything."
-- The /bidders table only listed bidders with PAID invoices, so on launch
-- weekend most of the 175 signups were invisible, and there was no phone,
-- search, or export anywhere. This RPC returns EVERY bidder with the
-- aggregates a single-operator console needs — one staff-gated call, the
-- page does search/sort/CSV client-side (trivial at this scale).
--
-- Staff-gated SECURITY DEFINER (operator_users, ERRCODE 42501) — same
-- pattern as bidder_signup_stats / operator_ops_health. Single-operator
-- platform: no per-operator scoping needed on bidders themselves; invoice
-- money is aggregated across all invoices (all BinGo's).

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

GRANT EXECUTE ON FUNCTION public.operator_bidder_directory() TO authenticated;

COMMIT;
