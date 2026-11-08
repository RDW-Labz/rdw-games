UPDATE bidders SET tax_exempt = false, resale_cert_status = NULL, unpaid_fees_cents = 500, postal_code = NULL, display_name = 'Bidder One', phone = NULL WHERE id = '00000000-0000-0000-0000-0000000000b1';
UPDATE bidder_fee_ledger SET paid_at = NULL, paid_payment_intent_id = NULL;
INSERT INTO bidders (id, email, birth_date, display_name) SELECT '00000000-0000-0000-0000-0000000000b1', 'b1@example.test', '1990-01-01', 'Bidder One' WHERE NOT EXISTS (SELECT 1 FROM bidders WHERE id = '00000000-0000-0000-0000-0000000000b1');
