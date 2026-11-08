ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1','b1@example.test'), ('00000000-0000-0000-0000-0000000000b2','b2@example.test');
INSERT INTO bidders (id, email, birth_date, display_name) VALUES
 ('00000000-0000-0000-0000-0000000000b1', 'b1@example.test', '1990-01-01', 'Bidder One'),
 ('00000000-0000-0000-0000-0000000000b2', 'b2@example.test', '1990-01-01', 'Bidder Two');
INSERT INTO bidder_fee_ledger (bidder_id, amount_cents, reason) VALUES ('00000000-0000-0000-0000-0000000000b1', 500, 'relot_fee');
UPDATE bidders SET unpaid_fees_cents = 500 WHERE id = '00000000-0000-0000-0000-0000000000b1';
