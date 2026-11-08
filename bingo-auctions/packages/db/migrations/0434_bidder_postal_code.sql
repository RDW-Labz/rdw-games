-- 0434 — bidder ZIP code: column + self-service RPCs + a read-only report.
--
-- WHAT
--   1. bidders.postal_code (5-digit US ZIP, optional) and three prompt columns
--      the bidder app uses to ask for it once, with a 30-day snooze.
--   2. set_my_postal_code(text)          the bidder sets / clears THEIR ZIP.
--   3. snooze_my_postal_code_prompt()    "Not now" on the app's ZIP prompt.
--   4. operator_bidder_location_summary(...)  console report: bidders, buyers
--      and net sales per ZIP and auction location. Read-only.
--      operator_bidder_zip_coverage()  one row: registered bidders and how
--      many gave a ZIP, each bidder counted once. Read-only.
--   5. A guard trigger: the four new columns are written only through the two
--      RPCs (or by server-side SECURITY DEFINER code), never by a direct
--      PostgREST UPDATE. A deleted account's ZIP is cleared.
--
-- WHY
--   Owner, 2026-10-21: plan auctions near where bidders live (Springdale is
--   opening as a second location). We hold no address for bidders today.
--
-- ── WHO CAN WRITE THE ZIP ────────────────────────────────────────────────────
--   bidders RLS (0133): bidders_self_update is USING/WITH CHECK id = auth.uid(),
--   and `authenticated` holds a TABLE-level UPDATE grant on bidders. So a
--   column-level `REVOKE UPDATE (postal_code, ...) FROM authenticated` would do
--   nothing: Postgres checks the table-level privilege first, and a column
--   REVOKE never removes a table-level grant. Making it work would mean
--   revoking table UPDATE and re-granting the other 54 columns one by one,
--   which changes grants on columns this migration has no business touching
--   (and every future column would silently be read-only).
--   Instead, trigger bidders_postal_code_guard (BEFORE INSERT OR UPDATE) raises
--   42501 'postal_code_via_rpc_only' when a PostgREST role (anon,
--   authenticated, service_role) writes any of the four columns directly. The
--   RPCs are SECURITY DEFINER, so inside them current_user is the function
--   owner and the write is allowed. Net effect: only the bidder, through
--   set_my_postal_code, changes their own ZIP; staff/operator sessions (and
--   the operator-web service-role client) cannot. Existing direct updates of
--   other columns (profile/edit.tsx, notifications, push token, ...) are
--   untouched, because the guard only compares the four new columns.
--   Account deletion (delete_my_account sets deleted_at) clears postal_code in
--   the same trigger.
--
-- ── REPORT RULES (operator_bidder_location_summary) ─────────────────────────
--   Access: SECURITY DEFINER, STABLE. Same caller check as load_summary (0429):
--     current_operator_id() set and current_operator_role() admin or manager,
--     else 42501 'bidder_location_forbidden'. A p_warehouse_id that is not the
--     caller's operator's raises the same error. EXECUTE: authenticated +
--     service_role; revoked from PUBLIC and anon (see 0430).
--   Bidders and operators: bidders are GLOBAL accounts (bidders.id =
--     auth.users.id, 0001); there is no per-operator registration table.
--     operator_bidder_relations (0078) only gets a row once someone bids. The
--     platform is single-operator (0235: operator_bidder_directory lists every
--     bidder), so "registered" = every bidder row with deleted_at IS NULL.
--     Activity is always scoped to the caller's operator (lots.operator_id /
--     invoices.operator_id). If a second operator ever shares this database,
--     the no-activity row must be re-scoped.
--   Range: [p_from, p_to). NULL means unbounded on that side.
--   One row per (ZIP group, location).
--     postal_code    the bidder's ZIP; 'Unknown' when they gave none. A ZIP
--                    with fewer than 3 registered (non-deleted) bidders in
--                    total rolls into 'Other (fewer than 3)', so no row names a
--                    person's ZIP. 'Unknown' is never rolled up. The roll-up
--                    uses all-time counts, so it doesn't change with the dates.
--     warehouse_id / warehouse_name
--                    the auction location of the activity. Bidders with no
--                    activity in the range get one row per ZIP group with
--                    warehouse_id NULL, name 'No activity in range'. A paid
--                    invoice whose auction/warehouse is missing or another
--                    operator's goes to NULL / 'Unassigned' (never dropped).
--     registered     bidders in the group with activity at that location in
--                    the range (or, on the no-activity row, with none at all).
--                    A bidder active at two locations counts on both rows, so
--                    registered SUMMED across warehouse rows double-counts
--                    multi-location bidders and is not the bidder total; use
--                    operator_bidder_zip_coverage() for that. Deleted
--                    accounts count only through activity (their ZIP is
--                    cleared, so they land in 'Unknown').
--     active_bidders placed >= 1 bid (bids.placed_at in range) on the
--                    operator's lots; location = the lot's auction's warehouse
--                    (a bid has no invoice to locate it by).
--     buyers         had >= 1 invoice PAID in the range (paid_at in range,
--                    status paid / partially_refunded / refunded).
--     paid_invoices  count of those invoices.
--     sales_net_cents  subtotal + buyer premium of those invoices, TAX
--                    EXCLUDED, minus refunds net of tax, as load_summary (0429):
--                    a refunded line (invoice_lots.refunded_at) takes off its
--                    hammer + its share of the premium (premium × hammer ÷
--                    subtotal, rounded); an invoice refunded as a whole
--                    (status 'refunded') nets to 0. Sales by paid_at.
--   Location of money = invoices.auction_id → auctions.warehouse_id. Never
--     lots.auction_id (it drifts on relists; see 0433). Invoices never span
--     auctions (UNIQUE (auction_id, bidder_id)), so no per-line split.
--   p_warehouse_id   only rows for that location (no 'No activity' or
--                    'Unassigned' rows).
--   p_zip_prefix     only ZIPs starting with these 1–5 digits ('Unknown'
--                    drops out). Anything else raises 22023
--                    'invalid_zip_prefix'. Empty = no filter.
--
-- ── LOCKS (Rule 9) ───────────────────────────────────────────────────────────
--   ALTER TABLE bidders takes a brief ACCESS EXCLUSIVE lock on bidders (every
--   bid, login and checkout reads it). The column adds are metadata-only on
--   PG11+ (nullable, or a constant default), and VALIDATE CONSTRAINT scans the
--   bidders table once (~1.4k rows, all NULL). CREATE TRIGGER takes SHARE ROW
--   EXCLUSIVE on bidders. lock_timeout 3s: if a long transaction holds
--   bidders, this fails fast instead of queueing every bid behind it — just
--   rerun. Window: 05:00–07:00 CT.
--
-- Rollback: scripts/prod-rig/0434_ROLLBACK_bidder_postal_code.sql

SET lock_timeout = '3s';

BEGIN;

-- ── 1. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS postal_code              text NULL,
  ADD COLUMN IF NOT EXISTS postal_code_updated_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS postal_code_prompt_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS postal_code_prompt_after timestamptz NULL,
  DROP CONSTRAINT IF EXISTS bidders_postal_code_format,
  ADD CONSTRAINT bidders_postal_code_format
    CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}$') NOT VALID;

ALTER TABLE public.bidders VALIDATE CONSTRAINT bidders_postal_code_format;

COMMENT ON COLUMN public.bidders.postal_code IS
  '0434: optional 5-digit US ZIP the bidder gave us (plan auctions near them). '
  'Written only via set_my_postal_code(); cleared on account deletion.';
COMMENT ON COLUMN public.bidders.postal_code_updated_at IS
  '0434: when the bidder last set or cleared postal_code.';
COMMENT ON COLUMN public.bidders.postal_code_prompt_count IS
  '0434: times the bidder tapped "Not now" on the app ZIP prompt (stops at 3).';
COMMENT ON COLUMN public.bidders.postal_code_prompt_after IS
  '0434: do not show the app ZIP prompt again before this time (30-day snooze).';

-- ── 2. Guard trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._bidders_postal_code_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Deliberately NOT security definer: current_user is the role making the
  -- write. Inside set_my_postal_code / snooze (SECURITY DEFINER) it is the
  -- function owner, so those writes pass.
  IF current_user IN ('anon', 'authenticated', 'service_role') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.postal_code IS NOT NULL
         OR NEW.postal_code_updated_at IS NOT NULL
         OR NEW.postal_code_prompt_count <> 0
         OR NEW.postal_code_prompt_after IS NOT NULL THEN
        RAISE EXCEPTION 'postal_code_via_rpc_only' USING ERRCODE = '42501',
          HINT = 'Use set_my_postal_code() / snooze_my_postal_code_prompt().';
      END IF;
    ELSIF NEW.postal_code              IS DISTINCT FROM OLD.postal_code
       OR NEW.postal_code_updated_at   IS DISTINCT FROM OLD.postal_code_updated_at
       OR NEW.postal_code_prompt_count IS DISTINCT FROM OLD.postal_code_prompt_count
       OR NEW.postal_code_prompt_after IS DISTINCT FROM OLD.postal_code_prompt_after THEN
      RAISE EXCEPTION 'postal_code_via_rpc_only' USING ERRCODE = '42501',
        HINT = 'Use set_my_postal_code() / snooze_my_postal_code_prompt().';
    END IF;
  END IF;

  -- Account deletion (delete_my_account tombstones by setting deleted_at):
  -- drop the ZIP with the rest of the personal data.
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
     AND NEW.postal_code IS NOT NULL THEN
    NEW.postal_code := NULL;
    NEW.postal_code_updated_at := now();
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS bidders_postal_code_guard ON public.bidders;
CREATE TRIGGER bidders_postal_code_guard
  BEFORE INSERT OR UPDATE ON public.bidders
  FOR EACH ROW EXECUTE FUNCTION public._bidders_postal_code_guard();

-- ── 3. set_my_postal_code ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_my_postal_code(p_postal_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_zip text := nullif(btrim(coalesce(p_postal_code, ''), E' \t\r\n'), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_zip IS NOT NULL AND v_zip !~ '^[0-9]{5}$' THEN
    RAISE EXCEPTION 'invalid_postal_code' USING ERRCODE = '22023';
  END IF;

  -- bidders.id = auth.users.id (0001), so the caller's row is id = auth.uid().
  UPDATE bidders
     SET postal_code = v_zip,
         postal_code_updated_at = now()
   WHERE id = v_uid
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bidder_not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.set_my_postal_code(text) IS
  '0434: the calling bidder sets (5 digits) or clears (NULL / empty) their own '
  'ZIP. 22023 invalid_postal_code otherwise.';

REVOKE ALL ON FUNCTION public.set_my_postal_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_my_postal_code(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_my_postal_code(text) TO authenticated;

-- ── 4. snooze_my_postal_code_prompt ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.snooze_my_postal_code_prompt()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE bidders
     SET postal_code_prompt_count = least(postal_code_prompt_count + 1, 32767),
         postal_code_prompt_after = now() + interval '30 days'
   WHERE id = v_uid
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bidder_not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.snooze_my_postal_code_prompt() IS
  '0434: "Not now" on the app ZIP prompt — count + 1, hide for 30 days. Caller only.';

REVOKE ALL ON FUNCTION public.snooze_my_postal_code_prompt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.snooze_my_postal_code_prompt() FROM anon;
GRANT EXECUTE ON FUNCTION public.snooze_my_postal_code_prompt() TO authenticated;

-- ── 5. operator_bidder_location_summary ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.operator_bidder_location_summary(
  p_from         timestamptz,
  p_to           timestamptz,
  p_warehouse_id uuid DEFAULT NULL,
  p_zip_prefix   text DEFAULT NULL
)
RETURNS TABLE(
  postal_code     text,
  warehouse_id    uuid,
  warehouse_name  text,
  registered      bigint,
  active_bidders  bigint,
  buyers          bigint,
  paid_invoices   bigint,
  sales_net_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op     uuid := current_operator_id();
  v_prefix text := nullif(btrim(coalesce(p_zip_prefix, '')), '');
BEGIN
  IF v_op IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_location_forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_warehouse_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM warehouses w WHERE w.id = p_warehouse_id AND w.operator_id = v_op
  ) THEN
    RAISE EXCEPTION 'bidder_location_forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_prefix IS NOT NULL AND v_prefix !~ '^[0-9]{1,5}$' THEN
    RAISE EXCEPTION 'invalid_zip_prefix' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH
  zip_sizes AS (
    SELECT b.postal_code AS zip, count(*) AS n
      FROM bidders b
     WHERE b.deleted_at IS NULL AND b.postal_code IS NOT NULL
     GROUP BY b.postal_code
  ),
  bz AS (
    SELECT b.id AS bidder_id,
           b.deleted_at,
           CASE WHEN b.postal_code IS NULL      THEN 'Unknown'
                WHEN coalesce(zs.n, 0) < 3      THEN 'Other (fewer than 3)'
                ELSE b.postal_code END          AS zip_group
      FROM bidders b
      LEFT JOIN zip_sizes zs ON zs.zip = b.postal_code
     WHERE v_prefix IS NULL OR b.postal_code LIKE v_prefix || '%'
  ),
  bid_act AS (
    SELECT DISTINCT bd.bidder_id, w.id AS wh
      FROM bids bd
      JOIN lots l            ON l.id = bd.lot_id
      LEFT JOIN auctions a   ON a.id = l.auction_id
      LEFT JOIN warehouses w ON w.id = a.warehouse_id AND w.operator_id = v_op
     WHERE l.operator_id = v_op
       AND (p_from IS NULL OR bd.placed_at >= p_from)
       AND (p_to   IS NULL OR bd.placed_at <  p_to)
  ),
  inv AS (
    SELECT i.id, i.bidder_id, w.id AS wh,
           coalesce(i.subtotal_cents, 0)      AS subtotal,
           coalesce(i.buyer_premium_cents, 0) AS premium,
           i.status::text                     AS status
      FROM invoices i
      LEFT JOIN auctions a   ON a.id = i.auction_id
      LEFT JOIN warehouses w ON w.id = a.warehouse_id AND w.operator_id = v_op
     WHERE i.operator_id = v_op
       AND i.paid_at IS NOT NULL
       AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
       AND (p_from IS NULL OR i.paid_at >= p_from)
       AND (p_to   IS NULL OR i.paid_at <  p_to)
  ),
  inv_net AS (
    SELECT inv.id, inv.bidder_id, inv.wh,
           CASE WHEN inv.status = 'refunded' THEN 0::bigint
                ELSE (inv.subtotal + inv.premium - coalesce((
                  SELECT sum(il.winning_bid_cents
                             + CASE WHEN inv.subtotal > 0
                                    THEN round(inv.premium::numeric * il.winning_bid_cents
                                               / inv.subtotal)::bigint
                                    ELSE 0 END)
                    FROM invoice_lots il
                   WHERE il.invoice_id = inv.id
                     AND il.refunded_at IS NOT NULL), 0))::bigint
           END AS net
      FROM inv
  ),
  act AS (
    SELECT ba.bidder_id, ba.wh, true AS is_bid, NULL::uuid AS invoice_id, 0::bigint AS net
      FROM bid_act ba
    UNION ALL
    SELECT n.bidder_id, n.wh, false, n.id, n.net
      FROM inv_net n
  ),
  act_rows AS (
    SELECT bz.zip_group,
           act.wh,
           count(DISTINCT act.bidder_id)                                  AS registered,
           count(DISTINCT act.bidder_id) FILTER (WHERE act.is_bid)        AS active_bidders,
           count(DISTINCT act.bidder_id) FILTER (WHERE NOT act.is_bid)    AS buyers,
           count(act.invoice_id)                                          AS paid_invoices,
           coalesce(sum(act.net), 0)::bigint                              AS sales_net_cents
      FROM act
      JOIN bz ON bz.bidder_id = act.bidder_id
     WHERE p_warehouse_id IS NULL OR act.wh = p_warehouse_id
     GROUP BY bz.zip_group, act.wh
  ),
  idle_rows AS (
    SELECT bz.zip_group, count(*) AS registered
      FROM bz
     WHERE bz.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM act WHERE act.bidder_id = bz.bidder_id)
     GROUP BY bz.zip_group
  ),
  out_rows AS (
    SELECT ar.zip_group, ar.wh,
           CASE WHEN ar.wh IS NULL THEN 'Unassigned' ELSE w.name END AS wh_name,
           ar.registered, ar.active_bidders, ar.buyers, ar.paid_invoices, ar.sales_net_cents,
           0 AS idle_sort
      FROM act_rows ar
      LEFT JOIN warehouses w ON w.id = ar.wh
    UNION ALL
    SELECT ir.zip_group, NULL::uuid, 'No activity in range',
           ir.registered, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
           1
      FROM idle_rows ir
     WHERE p_warehouse_id IS NULL
  )
  SELECT o.zip_group::text,
         o.wh,
         o.wh_name::text,
         o.registered::bigint,
         o.active_bidders::bigint,
         o.buyers::bigint,
         o.paid_invoices::bigint,
         o.sales_net_cents::bigint
    FROM out_rows o
   ORDER BY CASE o.zip_group WHEN 'Other (fewer than 3)' THEN 1 WHEN 'Unknown' THEN 2 ELSE 0 END,
            o.zip_group,
            o.idle_sort,
            o.wh_name;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_location_summary(timestamptz, timestamptz, uuid, text) IS
  '0434: registered / active bidders / buyers / paid invoices / net sales (tax '
  'excluded, refunds off) per bidder ZIP and auction location, [p_from, p_to). '
  'ZIPs with < 3 bidders roll into ''Other (fewer than 3)''. Admin/manager of '
  'current_operator_id() only (42501). Read-only.';

REVOKE ALL ON FUNCTION public.operator_bidder_location_summary(timestamptz, timestamptz, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_location_summary(timestamptz, timestamptz, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_location_summary(timestamptz, timestamptz, uuid, text)
  TO authenticated, service_role;

-- ── 6. operator_bidder_zip_coverage ─────────────────────────────────────────
-- One row, each of the operator's bidders counted exactly once, with the same
-- "registered" definition as the summary (non-deleted bidders; bidders are
-- global accounts on a single-operator platform, see the header).

CREATE OR REPLACE FUNCTION public.operator_bidder_zip_coverage()
RETURNS TABLE(registered bigint, with_zip bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF current_operator_id() IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_location_forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT count(*)::bigint,
         count(*) FILTER (WHERE b.postal_code IS NOT NULL)::bigint
    FROM bidders b
   WHERE b.deleted_at IS NULL;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_zip_coverage() IS
  '0434: registered bidders and how many gave a ZIP, each counted once. '
  'Admin/manager of current_operator_id() only (42501). Read-only.';

REVOKE ALL ON FUNCTION public.operator_bidder_zip_coverage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_zip_coverage() FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_zip_coverage() TO authenticated;

-- The trigger function is not callable directly (RETURNS trigger); keep its
-- ACL tidy anyway.
REVOKE ALL ON FUNCTION public._bidders_postal_code_guard() FROM PUBLIC;

COMMIT;
