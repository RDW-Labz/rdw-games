BEGIN;
REVOKE EXECUTE ON FUNCTION public.claim_refund(uuid, text, integer, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_refund(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_refund(uuid, text, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_refund(uuid, text) TO service_role;
COMMIT;
