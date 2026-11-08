-- 0473 cases. Each line prints PASS/FAIL <what>. Staff c1 unless noted.
\set ON_ERROR_STOP 1
\pset tuples_only on
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');

CREATE OR REPLACE FUNCTION t(p_lot int, p_bin text, p_name text DEFAULT 'Tim', p_why text DEFAULT 'Truck from Crandall') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.transfer_lot_to_bin(('00000000-0000-0000-0000-000000000' || p_lot)::uuid,
                                    ('00000000-0000-0000-0000-00000000aa' || p_bin)::uuid, p_name, p_why)
$$;
CREATE OR REPLACE FUNCTION ok(p_cond boolean, p_what text) RETURNS text LANGUAGE sql AS
$$ SELECT CASE WHEN p_cond THEN 'PASS ' ELSE 'FAIL ' END || p_what $$;

-- ---- The reported case: BRN4983203 (unsold no-show on a closed Crandall auction)
-- Old app path first: pending_move then confirm_move -> plain transfer_needed, not 0101's message.
SELECT ok(rig_err($q$SELECT public.confirm_move_lot_to_bin('00000000-0000-0000-0000-000000000113', '00000000-0000-0000-0000-00000000aad2')$q$)
          LIKE 'transfer_needed: this item belongs to Crandall inventory. Putting it on shelf 5-01-01 in Harrison%',
          'old app move of a no-show lot -> plain transfer_needed message (was 0101 uuid message)');
SELECT ok((SELECT warehouse_id = '00000000-0000-0000-0000-0000000000b2' AND intake_bin_id = '00000000-0000-0000-0000-0000000000d1' FROM lots WHERE id = '00000000-0000-0000-0000-000000000113'),
          'refused move left the lot on its Crandall shelf');

WITH r AS (SELECT t(101, 'd2') j)
SELECT ok((SELECT j->>'reason' = 'ok_transferred' AND j->>'from_warehouse' = 'Crandall' AND j->>'to_warehouse' = 'Harrison' AND j->>'bin_code' = '5-01-01'
             AND j->>'relotted_from' = '00000000-0000-0000-0000-000000000101' FROM r),
          'paid no-show lot: transfer allowed (owner 2026-10-27), via relot to inventory');
SELECT ok((SELECT status = 'relisted' AND auction_id IS NULL AND warehouse_id = '00000000-0000-0000-0000-0000000000b2' AND sticker_code IS NULL
             FROM lots WHERE id = '00000000-0000-0000-0000-000000000101'),
          'old row: relisted, detached from the closed auction, stays Crandall history');
SELECT ok((SELECT count(*) = 1 FROM invoice_lots WHERE lot_id = '00000000-0000-0000-0000-000000000101'),
          'old row keeps its paid invoice line');
SELECT ok((SELECT c.status = 'in_inventory' AND c.auction_id IS NULL AND c.warehouse_id = '00000000-0000-0000-0000-0000000000b1'
                  AND c.intake_bin_id = '00000000-0000-0000-0000-0000000000d2' AND c.sticker_code = 'RGX:BRN4983203' AND c.relist_origin = 'human_relot'
             FROM lots c WHERE c.relisted_from_lot_id = '00000000-0000-0000-0000-000000000101'),
          'new copy: in_inventory at Harrison 5-01-01 with the BRN4983203 sticker');
SELECT ok((SELECT a.action_type = 'lot.warehouse_transferred' AND a.reason_note = 'Truck from Crandall' AND a.after_state->>'staff_name' = 'Tim'
                  AND a.before_state->>'warehouse' = 'Crandall' AND a.after_state->>'warehouse' = 'Harrison'
                  AND a.actor_user_id = '00000000-0000-0000-0000-0000000000c1'
             FROM operator_audit_log a JOIN lots c ON c.id = a.target_id
            WHERE c.relisted_from_lot_id = '00000000-0000-0000-0000-000000000101'),
          'audit row: staff name, reason, from/to building, actor');
SELECT ok((SELECT count(*) >= 1 FROM lot_location_events e JOIN lots c ON c.id = e.lot_id
            WHERE c.relisted_from_lot_id = '00000000-0000-0000-0000-000000000101' AND e.bin_id = '00000000-0000-0000-0000-0000000000d2'),
          'location history records the move to 5-01-01');
SELECT ok((t(101, 'd3')->>'reason') = 'not_in_stock', 'second transfer of the old (relisted) row is refused');

-- ---- Plain inventory lot (no auction): moves itself, no relot.
WITH r AS (SELECT t(102, 'd3') j)
SELECT ok((SELECT j->>'reason' = 'ok_transferred' AND j->>'lot_id' = '00000000-0000-0000-0000-000000000102' AND j->>'relotted_from' IS NULL FROM r),
          'inventory lot transfers in place');
SELECT ok((SELECT warehouse_id = '00000000-0000-0000-0000-0000000000b1' AND intake_bin_id = '00000000-0000-0000-0000-0000000000d3' AND status = 'in_inventory'
             FROM lots WHERE id = '00000000-0000-0000-0000-000000000102'), 'inventory lot now at Harrison 5-01-02');

-- ---- Refusals (nothing moves)
SELECT ok((t(103, 'd2')->>'reason') = 'in_open_auction', 'unsold but its auction is still live: refused');
SELECT ok((t(104, 'd2')->>'reason') = 'in_sale', 'scheduled: refused');
SELECT ok((t(105, 'd2')->>'reason') = 'in_sale', 'live: refused');
SELECT ok((t(106, 'd2')->>'reason') = 'sold', 'won: refused');
SELECT ok((t(107, 'd2')->>'reason') = 'open_invoice', 'invoice still pending: refused');
SELECT ok((t(117, 'd2')->>'reason') = 'open_invoice', 'invoice in payment grace (still being paid): refused');
SELECT ok((t(108, 'd2')->>'reason') = 'staged_for_pickup', 'staged for pickup: refused');
SELECT ok((t(109, 'd2')->>'reason') = 'not_in_stock', 'canceled: refused');
SELECT ok((t(114, 'd2', '  ')->>'reason') = 'staff_name_required', 'blank staff name: refused');
SELECT ok((t(114, 'd2', 'Tim', '')->>'reason') = 'reason_required', 'blank reason: refused');
SELECT ok((t(114, 'd4')->>'reason') = 'not_a_transfer', 'same building: refused (use put-away)');
SELECT ok((t(114, 'd5')->>'reason') = 'bin_retired', 'retired shelf: refused');
SELECT ok((SELECT count(*) = 0 FROM lots WHERE id IN ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000105',
                                                        '00000000-0000-0000-0000-000000000106','00000000-0000-0000-0000-000000000107','00000000-0000-0000-0000-000000000108',
                                                        '00000000-0000-0000-0000-000000000109','00000000-0000-0000-0000-000000000114',
                                                        '00000000-0000-0000-0000-000000000117')
                                           AND warehouse_id <> '00000000-0000-0000-0000-0000000000b2'),
          'every refused lot is still Crandall');
SELECT ok((SELECT count(*) = 2 FROM operator_audit_log WHERE action_type = 'lot.warehouse_transferred'), 'only the 2 real transfers so far were audited');

SELECT rig_as('00000000-0000-0000-0000-0000000000c2');
SELECT ok((t(114, 'd2')->>'reason') = 'not_operator_staff', 'non-staff caller: refused');
SELECT rig_as(NULL);
SELECT ok((t(114, 'd2')->>'reason') = 'not_authenticated', 'no user: refused');
SELECT ok(NOT has_function_privilege('anon', 'public.transfer_lot_to_bin(uuid,uuid,text,text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.transfer_lot_to_bin(uuid,uuid,text,text)', 'EXECUTE'),
          'grants: anon no, authenticated yes');
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');

-- ---- Guard on the ordinary paths
SELECT ok(rig_err($q$SELECT public.confirm_move_lot_to_bin('00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-00000000aad2')$q$) LIKE 'transfer_needed:%',
          'shelved inventory lot, old move path to another building: refused (was a silent re-home)');
SELECT ok(rig_err($q$UPDATE lots SET intake_bin_id = '00000000-0000-0000-0000-0000000000d2', warehouse_id = '00000000-0000-0000-0000-0000000000b1' WHERE id = '00000000-0000-0000-0000-000000000110'$q$) LIKE 'transfer_needed:%',
          'direct UPDATE re-homing a shelved lot: refused');
SELECT ok((SELECT (public.confirm_move_lot_to_bin('00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-00000000aad4')).ok),
          'same-building move still works');
-- Owner 2026-10-27 (3): pending intake recorded at another building needs name + reason.
SELECT ok(rig_err($q$SELECT public.intake_lot_to_bin('BIN-000111', '00000000-0000-0000-0000-00000000aad2')$q$) LIKE 'transfer_needed:%',
          'pending_intake from Crandall, plain put-away at Harrison (no name/reason): refused');
SELECT ok((SELECT warehouse_id = '00000000-0000-0000-0000-0000000000b2' AND status = 'pending_intake' AND intake_bin_id IS NULL FROM lots WHERE id = '00000000-0000-0000-0000-000000000111'),
          '...it stayed pending_intake at Crandall, unshelved');
SELECT ok((SELECT (public.intake_lot_to_bin('BIN-000111', '00000000-0000-0000-0000-00000000aad4')).ok),
          'pending_intake put-away in its own building still works');
SELECT ok((t(116, 'd2', '', 'arrived on truck')->>'reason') = 'staff_name_required', 'pending_intake transfer without a name: refused');
SELECT ok((t(116, 'd2', 'Tim', '')->>'reason') = 'reason_required', 'pending_intake transfer without a reason: refused');
SELECT ok((SELECT warehouse_id = '00000000-0000-0000-0000-0000000000b2' AND status = 'pending_intake' FROM lots WHERE id = '00000000-0000-0000-0000-000000000116'),
          '...still pending_intake at Crandall');
WITH r AS (SELECT t(116, 'd2', 'Tim', 'arrived on the Crandall truck') j)
SELECT ok((SELECT j->>'reason' = 'ok_transferred' FROM r), 'pending_intake transfer with name + reason: allowed');
SELECT ok((SELECT warehouse_id = '00000000-0000-0000-0000-0000000000b1' AND status = 'in_inventory' AND intake_bin_id = '00000000-0000-0000-0000-0000000000d2' AND intake_at IS NOT NULL
             FROM lots WHERE id = '00000000-0000-0000-0000-000000000116'),
          '...now in_inventory at Harrison 5-01-01');
SELECT ok((SELECT (public.intake_lot_to_bin('BIN-000118', '00000000-0000-0000-0000-00000000aad2')).ok),
          'pending_intake with no building yet: plain put-away still works');
SELECT ok((SELECT (public.intake_lot_to_bin('BIN-000112', '00000000-0000-0000-0000-00000000aad2')).ok),
          'first put-away of a never-shelved lot still works');
SELECT ok(rig_err($q$UPDATE lots SET title = 'L10 renamed' WHERE id = '00000000-0000-0000-0000-000000000110'$q$) = 'no error',
          'non-shelf updates are untouched');
SELECT ok(rig_err($q$UPDATE lots SET intake_bin_id = NULL WHERE id = '00000000-0000-0000-0000-000000000110'$q$) = 'no error',
          'clearing a shelf is untouched');

-- The bypass flag is transaction-local and reset: a transfer then a direct
-- cross-building UPDATE in the SAME transaction is still refused.
SELECT ok(rig_err($q$DO $d$ BEGIN
    PERFORM public.transfer_lot_to_bin('00000000-0000-0000-0000-000000000114', '00000000-0000-0000-0000-00000000aad2', 'Tim', 'flag test');
    UPDATE lots SET intake_bin_id = '00000000-0000-0000-0000-0000000000d2' WHERE id = '00000000-0000-0000-0000-000000000115';
  END $d$$q$) LIKE 'transfer_needed:%',
  'flag does not leak to a later UPDATE in the same transaction');
SELECT ok((SELECT warehouse_id = '00000000-0000-0000-0000-0000000000b2' FROM lots WHERE id = '00000000-0000-0000-0000-000000000114'),
          '...and that whole transaction rolled back');
