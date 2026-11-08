-- 0475 bidder read cases (run AFTER cases.sql, same database, 0475 applied).
-- lots_bidder_read_published must let bidders read a 'refunded' lot, the
-- buyer included, and treat it exactly like a 'won' lot in every other way.
\set ON_ERROR_STOP 1
\pset tuples_only on
-- Rig-only: a Supabase project grants these to authenticated by default.
GRANT SELECT ON public.lots, public.invoice_lots, public.invoices, public.bids, public.operators, public.bidders TO authenticated;

-- L20 refunded, L21 won (the control); both won by b1 on invoice 2a1.
SET session_replication_role = replica;
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_number, title, lot_code, status, close_at, winner_bidder_id, current_bid_cents)
SELECT ('00000000-0000-0000-0000-0000000001' || n)::uuid, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
       '00000000-0000-0000-0000-00000000aa01', n, 'L' || n, 'L' || n, 'won', now() - interval '8 day',
       '00000000-0000-0000-0000-0000000000e1', 1000
  FROM unnest(ARRAY[20, 21]) n;
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents)
SELECT '00000000-0000-0000-0000-0000000002a1', ('00000000-0000-0000-0000-0000000001' || n)::uuid, 1000 FROM unnest(ARRAY[20, 21]) n;
INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents)
SELECT ('00000000-0000-0000-0000-0000000001' || n)::uuid, '00000000-0000-0000-0000-0000000000e1', 1000, 1000 FROM unnest(ARRAY[20, 21]) n;
SET session_replication_role = origin;

SELECT rig_as('00000000-0000-0000-0000-0000000000c1');
SELECT refund('20');
SELECT ok(st('L20') = 'refunded' AND st('L21') = 'won', 'setup: L20 refunded, L21 won');

SELECT count(*) AS old_n FROM lots
 WHERE operator_id = '00000000-0000-0000-0000-0000000000a1'
   AND status::text IN ('scheduled', 'live', 'won', 'unsold', 'relisted') \gset

CREATE OR REPLACE FUNCTION seen(p_code text) RETURNS int LANGUAGE sql AS
$$ SELECT count(*)::int FROM lots WHERE lot_code = p_code $$;
GRANT EXECUTE ON FUNCTION seen(text) TO authenticated;

-- Buyer (b1)
SELECT rig_as('00000000-0000-0000-0000-0000000000e1');
SET ROLE authenticated;
SELECT ok(seen('L20') = 1, 'buyer reads the refunded lot');
SELECT ok((SELECT count(*) FROM bids b JOIN lots l ON l.id = b.lot_id
            WHERE b.bidder_id = '00000000-0000-0000-0000-0000000000e1' AND l.lot_code = 'L20') = 1,
          'My Bids inner join keeps the refunded win');
SELECT ok((SELECT l.title FROM invoice_lots il LEFT JOIN lots l ON l.id = il.lot_id
            WHERE il.invoice_id = '00000000-0000-0000-0000-0000000002a1'
              AND il.lot_id = '00000000-0000-0000-0000-000000000120') = 'L20',
          'invoice line keeps its lot title');
SELECT ok((SELECT count(*) FROM lots WHERE operator_id = '00000000-0000-0000-0000-0000000000a1'
            AND status::text IN ('scheduled', 'live', 'won', 'unsold', 'relisted')) = :old_n,
          'old statuses: same lots visible as before');
SELECT ok((SELECT count(*) FROM lots WHERE status::text = 'in_inventory') = 0, 'in_inventory still hidden from bidders');
RESET ROLE;

-- Another bidder (b2): auction results
SELECT rig_as('00000000-0000-0000-0000-0000000000e2');
SET ROLE authenticated;
SELECT ok(seen('L20') = 1 AND seen('L21') = 1, 'other bidder reads it, same as a won lot (results)');
RESET ROLE;

-- Not a bidder: is_bidder() false
SELECT rig_as('00000000-0000-0000-0000-0000000000c2');
SET ROLE authenticated;
SELECT ok(seen('L20') = 0 AND seen('L21') = 0, 'non-bidder user: hidden, same as a won lot');
RESET ROLE;

-- Early access: same answer as a won lot
UPDATE lots SET early_access_until = now() + interval '1 day' WHERE lot_code IN ('L20', 'L21');
SELECT rig_as('00000000-0000-0000-0000-0000000000e1');
SET ROLE authenticated;
SELECT ok(seen('L20') = 0 AND seen('L21') = 0, 'early access: hidden from a non-member, same as a won lot');
RESET ROLE;
UPDATE lots SET early_access_until = NULL WHERE lot_code IN ('L20', 'L21');

-- Demo guard: same answer as a won lot (bidders cannot read operators, in
-- prod too, so the demo clause does not hide lots from bidders; unchanged).
UPDATE operators SET is_demo = true WHERE id = '00000000-0000-0000-0000-0000000000a1';
SET ROLE authenticated;
SELECT ok(seen('L20') = seen('L21'), 'demo operator: refunded answers the same as won');
RESET ROLE;
UPDATE bidders SET is_reviewer = true WHERE id = '00000000-0000-0000-0000-0000000000e1';
SET ROLE authenticated;
SELECT ok(seen('L20') = 1 AND seen('L21') = 1, 'demo operator: reviewer sees both');
RESET ROLE;
UPDATE bidders SET is_reviewer = false WHERE id = '00000000-0000-0000-0000-0000000000e1';
UPDATE operators SET is_demo = false WHERE id = '00000000-0000-0000-0000-0000000000a1';

SELECT ok((SELECT md5(pg_get_expr(polqual, polrelid)) FROM pg_policy
            WHERE polrelid = 'public.lots'::regclass AND polname = 'lots_bidder_read_published') = '47a1fc5867fb1127177d0623e8ad814c',
          'policy = prod policy + refunded (md5 47a1fc58)');
DROP FUNCTION seen(text);
