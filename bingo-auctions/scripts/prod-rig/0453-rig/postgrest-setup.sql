-- Prepare a 0453 copy for a real PostgREST: schema usage for the API roles
-- (Supabase sets these at project bootstrap; rig-stubs.sh does not), and
-- auth.uid() reading the JWT the way Supabase's does (request.jwt.claims).
\set ON_ERROR_STOP 1
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
