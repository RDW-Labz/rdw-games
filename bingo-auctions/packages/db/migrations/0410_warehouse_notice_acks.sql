-- 0410 — Off-site warehouse customer_notice acknowledgement before first bid.
-- Client gate only; place_bid unchanged. Mirrors operator_policy_acceptances +
-- record_operator_consent (0088/0380) for bidder resolution and IP/UA capture.

BEGIN;

CREATE TABLE IF NOT EXISTS public.warehouse_notice_acks (
  bidder_id    uuid        NOT NULL REFERENCES public.bidders(id) ON DELETE CASCADE,
  warehouse_id uuid        NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  notice_text  text        NOT NULL,
  acked_at     timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text,
  PRIMARY KEY (bidder_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS warehouse_notice_acks_bidder_idx
  ON public.warehouse_notice_acks (bidder_id, acked_at DESC);

ALTER TABLE public.warehouse_notice_acks ENABLE ROW LEVEL SECURITY;

-- Signed-in customers read their own rows (policy below). Writes only through
-- ack_warehouse_notice(); anon gets nothing.
REVOKE ALL ON public.warehouse_notice_acks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.warehouse_notice_acks TO authenticated;
GRANT ALL ON public.warehouse_notice_acks TO service_role;

DROP POLICY IF EXISTS "warehouse_notice_acks: bidder reads own" ON public.warehouse_notice_acks;
CREATE POLICY "warehouse_notice_acks: bidder reads own"
  ON public.warehouse_notice_acks
  FOR SELECT
  USING (bidder_id = auth.uid());

CREATE OR REPLACE FUNCTION public.ack_warehouse_notice(p_warehouse_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_bidder_id   uuid;
  v_notice      text;
  v_ip          text;
  v_ua          text;
  v_headers     json;
BEGIN
  v_bidder_id := auth.uid();
  IF v_bidder_id IS NULL THEN
    RAISE EXCEPTION 'ack_warehouse_notice: caller is not authenticated';
  END IF;

  SELECT btrim(w.customer_notice)
    INTO v_notice
    FROM warehouses w
    JOIN operators o ON o.id = w.operator_id
   WHERE w.id = p_warehouse_id
     AND w.active
     AND o.status = 'active';

  IF v_notice IS NULL OR v_notice = '' THEN
    RAISE EXCEPTION 'no_notice' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN OTHERS THEN v_headers := NULL; END;
  BEGIN
    v_ip := coalesce(
      nullif(btrim(split_part(v_headers ->> 'x-forwarded-for', ',', 1)), ''),
      v_headers ->> 'cf-connecting-ip',
      nullif(current_setting('request.headers.x-forwarded-for', true), ''));
  EXCEPTION WHEN OTHERS THEN v_ip := NULL; END;
  BEGIN
    v_ua := coalesce(
      nullif(v_headers ->> 'user-agent', ''),
      nullif(current_setting('request.headers.user-agent', true), ''));
  EXCEPTION WHEN OTHERS THEN v_ua := NULL; END;

  INSERT INTO warehouse_notice_acks (bidder_id, warehouse_id, notice_text, ip, user_agent)
  VALUES (v_bidder_id, p_warehouse_id, v_notice, v_ip, v_ua)
  ON CONFLICT (bidder_id, warehouse_id) DO UPDATE
    SET notice_text = EXCLUDED.notice_text,
        acked_at    = now(),
        ip          = EXCLUDED.ip,
        user_agent  = EXCLUDED.user_agent;
END;
$func$;

CREATE OR REPLACE FUNCTION public.has_acked_warehouse_notice(p_warehouse_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_bidder_id uuid;
  v_notice    text;
BEGIN
  v_bidder_id := auth.uid();
  IF v_bidder_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT btrim(w.customer_notice)
    INTO v_notice
    FROM warehouses w
    JOIN operators o ON o.id = w.operator_id
   WHERE w.id = p_warehouse_id
     AND w.active
     AND o.status = 'active';

  IF v_notice IS NULL OR v_notice = '' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM warehouse_notice_acks a
     WHERE a.bidder_id = v_bidder_id
       AND a.warehouse_id = p_warehouse_id
       AND a.notice_text = v_notice
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.ack_warehouse_notice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ack_warehouse_notice(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_acked_warehouse_notice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_acked_warehouse_notice(uuid) TO authenticated, service_role;

COMMIT;
