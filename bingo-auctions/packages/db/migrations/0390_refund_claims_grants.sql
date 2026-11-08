BEGIN;
REVOKE EXECUTE ON FUNCTION public.claim_refund(uuid, text, integer, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_refund(uuid, text) FROM anon, authenticated;
COMMIT;
