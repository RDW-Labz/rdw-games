-- The rig's auth stub has only (id, email). delete_my_account writes these
-- Supabase auth columns and auth.identities, so add them (rig only).
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS encrypted_password TEXT,
  ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS phone_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raw_user_meta_data JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS auth.identities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID);
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
-- Supabase gives every new table to anon/authenticated by default; reproduce
-- it so 0469's REVOKEs are really tested.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
