-- 0401 — operators_public is read-only for anon and authenticated.
--
-- Found 2026-10-07 (read-only check on prod): the view operators_public
-- (0204) is owned by postgres, runs with security_invoker=false, is
-- auto-updatable (a plain SELECT ... FROM operators), and anon + authenticated
-- hold INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on it. A write
-- through the view runs as the owner and skips operators' RLS, so anyone with
-- the public anon key could change or delete operator rows (buyer premium, bid
-- increments, status, contact email), e.g.
--   SET ROLE anon; UPDATE operators_public SET default_buyer_premium_bps = 9999;
-- changed the operators row on the rig with prod's grants (rolled back). It is
-- the only updatable public view anon can write.
--
-- Nothing in the apps writes through it (grep apps/, packages/, scripts/:
-- every use is a SELECT), so this keeps SELECT and revokes everything else.
-- The view, its columns and its read behaviour are unchanged.
--
-- Rollback (only if something legitimately needed a write, which nothing does):
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.operators_public TO anon, authenticated;
-- Window: security fix, no lock beyond a brief catalog update; any hour, sooner is better.

BEGIN;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.operators_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.operators_public TO anon, authenticated;
COMMIT;
