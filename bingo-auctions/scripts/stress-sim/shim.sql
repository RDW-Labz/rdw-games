-- Supabase-stub shim for running the full migration set on vanilla Postgres.
-- Mirrors .github/workflows/ci.yml "Apply migrations in order", with ONE
-- deliberate difference: auth.uid() reads the app.sim_uid session GUC so the
-- stress driver can impersonate bidders through the real place_bid RPC.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
-- email included: bidders_lock_email_to_auth() trigger reads it (CI never
-- inserts bidders so the plain-id stub suffices there; the sim does).
CREATE TABLE IF NOT EXISTS auth.users (id uuid primary key, email text);

CREATE TABLE storage.buckets (
  id                  text PRIMARY KEY,
  name                text,
  owner               uuid,
  owner_id            text,
  public              boolean DEFAULT false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  avif_autodetection  boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
CREATE TABLE storage.objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id     text REFERENCES storage.buckets(id),
  name          text,
  owner         uuid,
  owner_id      text,
  metadata      jsonb,
  path_tokens   text[],
  version       text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now()
);

-- SIM DIFFERENCE vs CI: session-settable uid for bidder impersonation.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.sim_uid', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
  LANGUAGE sql AS $$ SELECT string_to_array(name, '/') $$;

CREATE PUBLICATION supabase_realtime;

CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, nodename text, nodeport int, database text, username text, active boolean DEFAULT true, jobname text);
CREATE TABLE IF NOT EXISTS cron.job_run_details (jobid bigint, runid bigserial PRIMARY KEY, job_pid int, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz);
CREATE OR REPLACE FUNCTION cron.schedule(p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job(schedule, command) VALUES (p_schedule, p_command); SELECT 0::bigint $$;
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job(jobname, schedule, command) VALUES (p_name, p_schedule, p_command); SELECT 0::bigint $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = p_name; SELECT true $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_jobid bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION extensions.digest(data text, algorithm text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5(data), 'hex') $$;
