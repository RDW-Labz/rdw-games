-- Rollback for 0430 — standby only. Restores anon EXECUTE on the two functions.
BEGIN;
GRANT EXECUTE ON FUNCTION public.load_summary(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text, text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) TO anon;
COMMIT;
