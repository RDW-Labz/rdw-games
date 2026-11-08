-- ============================================================================
-- 0057_lots_soft_delete
--
-- Adds soft-delete support to lots. Operators bulk-cleaning their
-- inventory want a recoverable "Trash" stage rather than immediate
-- deletion — accidents shouldn't be irreversible. Hard-delete still
-- exists (operator can permanently empty trash; future cron may sweep
-- > 30 day rows automatically).
--
-- Schema:
--   lots.deleted_at  TIMESTAMPTZ NULL — when the lot was soft-deleted.
--                                       NULL = active.
--   lots.deleted_by  UUID NULL       — auth.users.id who soft-deleted.
--                                       NULL when not yet deleted; left
--                                       set after a restore so we have
--                                       audit history of who touched it
--                                       last (deleted_at goes back to
--                                       NULL on restore).
--
-- Read-side guard: every existing reader (auction builder, /inventory,
-- mobile inventory hook, RPCs) is updated in the corresponding TS commit
-- to filter `deleted_at IS NULL`. RLS itself is NOT modified — soft-
-- delete is operator-policy, not access-policy. Bidders never see
-- pending_intake/in_inventory anyway, so the change is operator-only.
--
-- Indexes: a partial index on (operator_id) WHERE deleted_at IS NULL
-- keeps the hot-path "give me my active inventory" query fast even
-- after the trash grows large. The existing lots_operator_idx still
-- works for lookups across both states.
-- ============================================================================

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Active-rows partial index. Most operator queries filter on
-- "lots I own that haven't been trashed" — this keeps that path tight
-- without bloating every-row scans.
CREATE INDEX IF NOT EXISTS lots_active_operator_idx
  ON lots (operator_id, status)
  WHERE deleted_at IS NULL;

-- Trash-only index for the /lotting/trash page. Tiny by definition
-- (deleted rows are a fraction of total) but speeds the trash
-- listing's order-by-deleted_at query.
CREATE INDEX IF NOT EXISTS lots_trash_operator_idx
  ON lots (operator_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN lots.deleted_at IS
  '0057: soft-delete timestamp. NULL = active. Set by deleteInventoryLots; cleared by restoreLots.';
COMMENT ON COLUMN lots.deleted_by IS
  '0057: auth.users.id of the operator-staff who soft-deleted. Survives restore as audit trail.';
