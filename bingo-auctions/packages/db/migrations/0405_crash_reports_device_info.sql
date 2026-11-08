-- XXXX — client_crash_reports device context from staff crash telemetry.
-- Owner assigns the migration number when copying into packages/db/migrations.

ALTER TABLE public.client_crash_reports
  ADD COLUMN IF NOT EXISTS device_model text,
  ADD COLUMN IF NOT EXISTS os_version text,
  ADD COLUMN IF NOT EXISTS free_storage_bytes bigint,
  ADD COLUMN IF NOT EXISTS total_memory_bytes bigint,
  ADD COLUMN IF NOT EXISTS js_heap_bytes bigint;
