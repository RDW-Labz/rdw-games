-- ROLLBACK for 0487_undo_invoice_line_pickup.sql.
--
-- Drops the function and its completion guard. The console's Undo pickup
-- button then errors and changes nothing.
--
-- DATA RESTORE (optional, one undone line at a time)
--   Pass the audit row id of an 'invoice_line.pickup_undone' entry:
--
--     psql -1 -v restore_audit_id=<audit id> -f this_file
--
--   The restore is fully guarded and reads everything from that audit row:
--     * the line's exact prior picked_up_at, restored only while the line is
--       still un-stamped and not refunded;
--     * the exact prior bin_assignments row (id, status, picked_up_at), only
--       while that row is still the lot's CURRENT assignment and the staged
--       row this function wrote;
--     * the 'collected' outcome and pickup-pass ticks it removed, only after
--       the line itself is restored;
--     * the pickup's prior 'completed' state, ONLY when no other line is owed
--       (refunded / missing / left_behind lines excepted). That prevents the
--       0356 completion trigger from stamping an unrelated owed line.
--
--   If any guard refuses (refunded line, moved/re-staged bin, repeated audit
--   id), the WHOLE restore is a no-op: no line stamp, bin, outcome, tick or
--   pickup changes.
--
--   Run it with `psql -1` so every statement commits or rolls back together.
--   Audit rows written before this rollback recipe existed have no bin /
--   outcome / tick detail; those pieces are skipped and the line is still
--   restored.
--
--   Without restore_audit_id the file only drops the function and trigger.
--
-- The function never moved money, so there is no money to restore.

SET lock_timeout = '3s';

\if :{?restore_audit_id}

-- Decide whether this restore may touch the row at all. A refused restore is
-- a complete no-op: the line, its bin row, the removed outcome/tick and the
-- pickup all stay exactly as they are.
--   * the line must still be un-stamped and un-refunded;
--   * a recorded bin row must still be the lot's CURRENT assignment, still
--     'staged' and still un-stamped — a lot that was moved or re-staged after
--     the undo is a different shelf row and must not be flipped back;
--   * a newer undo of the same line makes this audit row historical, so
--     replaying it must not resurrect an older stamp;
--   * a repeated audit id (line already restored) or a refunded line (line
--     restore refused) therefore restores nothing, including the bin.
--
-- The preflight is a SNAPSHOT, never a promise. Everything it decides is
-- re-checked against the live rows in the writes below, because a refund, a
-- move/re-stage or a newer undo can commit between the two (#796). Rollback
-- runs with `psql -1`, so the whole recipe is still one transaction.
\if :{?restore_skip_preflight}
  -- Writes-only pass: reuse the temp tables an earlier preflight-only call
  -- created in this same transaction (the concurrency regression test).
\else
DROP TABLE IF EXISTS pg_temp._0487_restore;
CREATE TEMP TABLE _0487_restore ON COMMIT DROP AS
SELECT *
  FROM operator_audit_log
 WHERE id = :'restore_audit_id'::bigint
   AND action_type = 'invoice_line.pickup_undone';

-- Serialize against the writers that would invalidate the decision:
-- refunds lock invoice_lots, put-away/transfers lock lots, and the undo path
-- locks the line. Taking the same rows first means a concurrent writer either
-- committed before the snapshot below or waits for this transaction.
SELECT il.invoice_id
  FROM invoice_lots il
  JOIN _0487_restore a
    ON il.invoice_id = a.target_id
   AND il.lot_id = (a.before_state->>'lot_id')::uuid
 FOR UPDATE OF il;

SELECT l.id
  FROM lots l
  JOIN _0487_restore a
    ON l.id = (a.before_state->>'lot_id')::uuid
 FOR UPDATE OF l;

SELECT ba.id
  FROM bin_assignments ba
  JOIN _0487_restore a
    ON ba.id = (a.before_state->'bin_assignment'->>'id')::uuid
 FOR UPDATE OF ba;

DROP TABLE IF EXISTS pg_temp._0487_restore_ok;
CREATE TEMP TABLE _0487_restore_ok ON COMMIT DROP AS
SELECT a.*
  FROM _0487_restore a
 WHERE a.after_state->>'picked_up_at' IS NULL
   AND a.before_state->>'picked_up_at' IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM invoice_lots il
          WHERE il.invoice_id = a.target_id
            AND il.lot_id = (a.before_state->>'lot_id')::uuid
            AND il.picked_up_at IS NULL
            AND il.refunded_at IS NULL
       )
   AND NOT EXISTS (
         SELECT 1 FROM operator_audit_log newer
          WHERE newer.action_type = 'invoice_line.pickup_undone'
            AND newer.target_id = a.target_id
            AND newer.before_state->>'lot_id' = a.before_state->>'lot_id'
            AND (newer.created_at, newer.id) > (a.created_at, a.id)
       )
   AND (
         a.before_state->'bin_assignment' IS NULL
         OR a.before_state->'bin_assignment' = 'null'::jsonb
         OR a.before_state->'bin_assignment'->>'status' <> 'picked_up'
         OR EXISTS (
              SELECT 1 FROM bin_assignments ba
               WHERE ba.id = (a.before_state->'bin_assignment'->>'id')::uuid
                 AND ba.lot_id = (a.before_state->>'lot_id')::uuid
                 AND ba.status = 'staged'
                 AND ba.picked_up_at IS NULL
                 AND ba.id = (
                       SELECT latest.id FROM bin_assignments latest
                        WHERE latest.lot_id = ba.lot_id
                        ORDER BY latest.assigned_at DESC, latest.id DESC
                        LIMIT 1)
            )
       );
\endif

\if :{?restore_preflight_only}
  -- Preflight-only pass: stop before writing (test hook for the concurrency
  -- regression). Nothing has changed yet.
\else
-- The line. Re-checks the live row AND that the recorded bin row is still the
-- lot's current assignment, so a refund/move committed after the preflight
-- refuses the whole restore instead of half-applying it.
WITH a AS (
  SELECT * FROM _0487_restore_ok
)
UPDATE invoice_lots il
   SET picked_up_at = (a.before_state->>'picked_up_at')::timestamptz
  FROM a
 WHERE il.invoice_id = a.target_id
   AND il.lot_id = (a.before_state->>'lot_id')::uuid
   AND il.picked_up_at IS NULL
   AND il.refunded_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM operator_audit_log newer
          WHERE newer.action_type = 'invoice_line.pickup_undone'
            AND newer.target_id = a.target_id
            AND newer.before_state->>'lot_id' = a.before_state->>'lot_id'
            AND (newer.created_at, newer.id) > (a.created_at, a.id)
       )
   AND (
         a.before_state->'bin_assignment' IS NULL
         OR a.before_state->'bin_assignment' = 'null'::jsonb
         OR a.before_state->'bin_assignment'->>'status' <> 'picked_up'
         OR EXISTS (
              SELECT 1 FROM bin_assignments ba
               WHERE ba.id = (a.before_state->'bin_assignment'->>'id')::uuid
                 AND ba.lot_id = il.lot_id
                 AND ba.status = 'staged'
                 AND ba.picked_up_at IS NULL
                 AND ba.id = (
                       SELECT latest.id FROM bin_assignments latest
                        WHERE latest.lot_id = ba.lot_id
                        ORDER BY latest.assigned_at DESC, latest.id DESC
                        LIMIT 1)
            )
       );

-- The exact prior bin row, only when the line was actually restored above and
-- that row is STILL the lot's current assignment.
WITH a AS (
  SELECT * FROM _0487_restore_ok
)
UPDATE bin_assignments ba
   SET status        = 'picked_up',
       picked_up_at  = (a.before_state->'bin_assignment'->>'picked_up_at')::timestamptz
  FROM a
 WHERE ba.id = (a.before_state->'bin_assignment'->>'id')::uuid
   AND a.before_state->'bin_assignment'->>'status' = 'picked_up'
   AND ba.status = 'staged'
   AND ba.picked_up_at IS NULL
   AND ba.id = (
         SELECT latest.id FROM bin_assignments latest
          WHERE latest.lot_id = ba.lot_id
          ORDER BY latest.assigned_at DESC, latest.id DESC
          LIMIT 1)
   AND EXISTS (
         SELECT 1 FROM invoice_lots il
          WHERE il.invoice_id = a.target_id
            AND il.lot_id = (a.before_state->>'lot_id')::uuid
            AND il.picked_up_at IS NOT NULL
       );

WITH restored AS (
  SELECT (a.before_state->>'lot_id')::uuid AS lot_id,
         a.target_id AS invoice_id,
         a.before_state->'removed_collected_outcomes' AS removed
    FROM _0487_restore_ok a
   WHERE jsonb_typeof(a.before_state->'removed_collected_outcomes') = 'array'
)
INSERT INTO pickup_lot_outcomes
  (pickup_id, lot_id, outcome, note, decided_by, created_at, decided_at)
SELECT (e->>'pickup_id')::uuid,
       (e->>'lot_id')::uuid,
       e->>'outcome',
       e->>'note',
       (e->>'decided_by')::uuid,
       (e->>'created_at')::timestamptz,
       COALESCE((e->>'decided_at')::timestamptz, (e->>'created_at')::timestamptz)
  FROM restored r
  CROSS JOIN LATERAL jsonb_array_elements(r.removed) e
 WHERE EXISTS (
         SELECT 1 FROM invoice_lots il
          WHERE il.invoice_id = r.invoice_id
            AND il.lot_id = r.lot_id
            AND il.picked_up_at IS NOT NULL
       )
ON CONFLICT (pickup_id, lot_id) DO NOTHING;

WITH restored AS (
  SELECT (a.before_state->>'lot_id')::uuid AS lot_id,
         a.target_id AS invoice_id,
         a.before_state->'removed_session_ticks' AS removed
    FROM _0487_restore_ok a
   WHERE jsonb_typeof(a.before_state->'removed_session_ticks') = 'array'
)
UPDATE pickup_sessions ps
   SET collected_lot_ids = array_append(ps.collected_lot_ids, r.lot_id)
  FROM restored r
  CROSS JOIN LATERAL jsonb_array_elements(r.removed) e
 WHERE ps.id = (e->>'id')::uuid
   AND EXISTS (
         SELECT 1 FROM invoice_lots il
          WHERE il.invoice_id = r.invoice_id
            AND il.lot_id = r.lot_id
            AND il.picked_up_at IS NOT NULL
       )
   AND NOT ps.collected_lot_ids @> ARRAY[r.lot_id];

WITH a AS (
  SELECT * FROM _0487_restore_ok
)
UPDATE pickups p
   SET status        = 'completed',
       completed_at  = COALESCE((a.before_state->>'pickup_completed_at')::timestamptz, p.completed_at, now()),
       completed_by  = COALESCE((a.before_state->>'pickup_completed_by')::uuid, p.completed_by),
       updated_at    = now()
  FROM a
 WHERE p.id = (a.before_state->>'pickup_id')::uuid
   AND a.before_state->>'pickup_status' = 'completed'
   AND p.status = 'checked_in'
   AND EXISTS (
         SELECT 1 FROM invoice_lots il
          WHERE il.invoice_id = a.target_id
            AND il.lot_id = (a.before_state->>'lot_id')::uuid
            AND il.picked_up_at IS NOT NULL
       )
   AND NOT EXISTS (
         SELECT 1
           FROM invoice_lots il
          WHERE il.invoice_id = p.invoice_id
            AND il.picked_up_at IS NULL
            AND il.refunded_at IS NULL
            AND NOT EXISTS (
                  SELECT 1 FROM pickup_lot_outcomes o
                   WHERE o.pickup_id = p.id
                     AND o.lot_id = il.lot_id
                     AND o.outcome IN ('missing', 'left_behind')
                )
       );
\endif

\endif

\if :{?keep_function}
  -- Test/automation path: leave the functions in place.
\else
  DROP TRIGGER IF EXISTS pickups_guard_undone_lines_trg ON public.pickups;
  DROP FUNCTION IF EXISTS public.pickups_guard_undone_lines_on_complete();
  DROP FUNCTION IF EXISTS public.undo_invoice_line_pickup(uuid, uuid, text);
\endif
