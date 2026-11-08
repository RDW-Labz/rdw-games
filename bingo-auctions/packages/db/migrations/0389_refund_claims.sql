BEGIN;
CREATE TABLE IF NOT EXISTS public.refund_claims (
  invoice_id  UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  claim_key   TEXT NOT NULL CHECK (length(claim_key) BETWEEN 1 AND 128),
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by  UUID,
  released_at TIMESTAMPTZ,
  PRIMARY KEY (invoice_id, claim_key)
);
ALTER TABLE public.refund_claims ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.claim_refund(p_invoice_id uuid, p_claim_key text, p_window_seconds integer DEFAULT 60, p_claimed_by uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rows integer;
BEGIN
  IF p_invoice_id IS NULL OR p_claim_key IS NULL OR length(p_claim_key) = 0 THEN RETURN false; END IF;
  INSERT INTO refund_claims (invoice_id, claim_key, claimed_at, claimed_by, released_at)
  VALUES (p_invoice_id, p_claim_key, now(), p_claimed_by, NULL)
  ON CONFLICT (invoice_id, claim_key) DO UPDATE
     SET claimed_at = now(), claimed_by = EXCLUDED.claimed_by, released_at = NULL
   WHERE refund_claims.released_at IS NOT NULL
      OR refund_claims.claimed_at < now() - make_interval(secs => GREATEST(p_window_seconds, 1));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END; $$;
CREATE OR REPLACE FUNCTION public.release_refund(p_invoice_id uuid, p_claim_key text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE refund_claims SET released_at = now() WHERE invoice_id = p_invoice_id AND claim_key = p_claim_key AND released_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION public.claim_refund(uuid, text, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_refund(uuid, text) TO service_role;
COMMIT;
