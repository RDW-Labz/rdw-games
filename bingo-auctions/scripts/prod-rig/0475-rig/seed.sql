-- 0475 rig seed. Synthetic only: example.test addresses, fixed uuids.
-- One closed auction; invoices per scenario; lots all 'won' unless noted.
\set ON_ERROR_STOP 1
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
SET search_path = public, extensions;
-- Prod has pgcrypto in schema `extensions` (verify_worker_pin calls
-- extensions.crypt); the rig has it in public. Rig-only shims.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION extensions.crypt(text, text) RETURNS text LANGUAGE sql AS 'SELECT public.crypt($1, $2)';
CREATE OR REPLACE FUNCTION extensions.gen_salt(text) RETURNS text LANGUAGE sql AS 'SELECT public.gen_salt($1)';
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
SET session_replication_role = replica;

INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 'station@example.test'),
 ('00000000-0000-0000-0000-0000000000c2', 'outsider@example.test'),
 ('00000000-0000-0000-0000-0000000000e1', 'b1@example.test'),
 ('00000000-0000-0000-0000-0000000000e2', 'b2@example.test');
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'rig475', 'Rig 475', 'o@example.test', 'RGW');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1', 'Harrison', '1 St', '00000000-0000-0000-0000-0000000000a1', 'AR', '72601', 'Harrison');
INSERT INTO operator_users (id, operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'admin', 'station@example.test');
INSERT INTO bidders (id, email, birth_date) VALUES
 ('00000000-0000-0000-0000-0000000000e1', 'b1@example.test', '1980-01-01'),
 ('00000000-0000-0000-0000-0000000000e2', 'b2@example.test', '1980-01-01');

-- Workers: w1 manager PIN 2468, w2 picker PIN 1357.
INSERT INTO workers (id, operator_id, display_name, pin_hash, role) VALUES
 ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Tim', crypt('2468', gen_salt('bf')), 'manager'),
 ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'Picker Pat', crypt('1357', gen_salt('bf')), 'picker');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Closed A', 'closed', now()-interval '9 day', now()-interval '8 day', now()-interval '8 day', now()+interval '3 day'),
 ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Closed B', 'closed', now()-interval '9 day', now()-interval '8 day', now()-interval '8 day', now()+interval '3 day'),
 ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Next', 'scheduled', now()+interval '1 day', now()+interval '2 day', now()+interval '2 day', now()+interval '5 day');

-- Lots (lot_code = label):
--  L01 refund, never picked up            (TEA4842561 shape)
--  L02 picked up, then refunded            (buyer took it)
--  L03 / L04 two lines; only L03 refunded  (partial refund, other line open)
--  L05 reported missing, then refunded
--  L06 also on an open invoice for b2      (other open sale)
--  L07 forfeited (no-show), then refunded
--  L08 picked up normally                  (no refund)
--  L09 legacy: won with every line refunded (pre-0475 shape)
--  L10 won, line not refunded              (relist_refunded_lot refuses)
--  L11 plain relist of an unsold lot       (unchanged flow)
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_number, title, lot_code, status, close_at, winner_bidder_id, current_bid_cents)
SELECT ('00000000-0000-0000-0000-0000000001' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
       '00000000-0000-0000-0000-00000000aa01', n, 'L' || lpad(n::text, 2, '0'), 'L' || lpad(n::text, 2, '0'),
       (CASE WHEN n = 11 THEN 'unsold' ELSE 'won' END)::lot_status, now()-interval '8 day',
       CASE WHEN n = 11 THEN NULL ELSE '00000000-0000-0000-0000-0000000000e1'::uuid END, 1000
  FROM generate_series(1, 11) n;

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents, buyer_premium_cents, tax_cents, total_cents, square_payment_id, paid_at) VALUES
 ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e1', 'paid', 10000, 1500, 920, 12420, 'sq-1', now()-interval '7 day'),
 ('00000000-0000-0000-0000-0000000002a2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000e2', 'paid', 1000, 150, 92, 1242, 'sq-2', now()-interval '7 day');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at, forfeited_at, refunded_at)
SELECT '00000000-0000-0000-0000-0000000002a1', ('00000000-0000-0000-0000-0000000001' || lpad(n::text, 2, '0'))::uuid, 1000,
       CASE WHEN n IN (2, 8) THEN now()-interval '2 day' END,
       CASE WHEN n = 7 THEN now()-interval '1 day' END,
       CASE WHEN n = 9 THEN now()-interval '3 day' END
  FROM generate_series(1, 10) n;
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES
 ('00000000-0000-0000-0000-0000000002a2', '00000000-0000-0000-0000-000000000106', 1000);

INSERT INTO pickups (id, invoice_id, warehouse_id, status) VALUES
 ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000b1', 'checked_in');
INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome) VALUES
 ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-000000000105', 'missing');

SET session_replication_role = origin;

CREATE OR REPLACE FUNCTION rig_as(p uuid) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('request.jwt.claim.sub', coalesce(p::text, ''), false) $$;
CREATE OR REPLACE FUNCTION rig_err(p_sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE p_sql; RETURN 'no error'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
