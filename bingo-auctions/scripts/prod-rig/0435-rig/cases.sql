-- t(name, sql, expect): expect 'ok' or an SQLSTATE; runs sql as the role/sub given in sql itself.
CREATE OR REPLACE FUNCTION pg_temp.t(p_name text, p_role text, p_sql text, p_expect text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := 'ok';
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_sql;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE; RESET ROLE;
  END;
  RETURN CASE WHEN v = p_expect THEN 'PASS ' ELSE 'FAIL ' END || p_name || ' (got ' || v || ', want ' || p_expect || ')';
END $$;
SELECT pg_temp.t('bidder edits own display_name', 'authenticated', $q$UPDATE bidders SET display_name = 'New' WHERE id = auth.uid()$q$, :'e_ok');
SELECT pg_temp.t('bidder edits own phone', 'authenticated', $q$UPDATE bidders SET phone = '5555550100' WHERE id = auth.uid()$q$, :'e_ok');
SELECT pg_temp.t('bidder toggles push/email/sms', 'authenticated', $q$UPDATE bidders SET push_enabled = false, email_enabled = false, sms_enabled = true WHERE id = auth.uid()$q$, :'e_ok');
SELECT pg_temp.t('bidder registers push token', 'authenticated', $q$UPDATE bidders SET expo_push_token = 'ExponentPushToken[x]', push_registered_at = now() WHERE id = auth.uid()$q$, :'e_ok');
SELECT pg_temp.t('bidder sets own tax_exempt', 'authenticated', $q$UPDATE bidders SET tax_exempt = true WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('bidder zeroes own unpaid_fees_cents', 'authenticated', $q$UPDATE bidders SET unpaid_fees_cents = 0 WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('bidder resets no_show_count', 'authenticated', $q$UPDATE bidders SET no_show_count = 0 WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('bidder approves own resale cert', 'authenticated', $q$UPDATE bidders SET resale_cert_status = 'approved' WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('bidder sets subscription_status', 'authenticated', $q$UPDATE bidders SET subscription_status = subscription_status WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('bidder changes bidder_number', 'authenticated', $q$UPDATE bidders SET bidder_number = 1 WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('bidder sets postal_code directly', 'authenticated', $q$UPDATE bidders SET postal_code = '72601' WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('bidder inserts a bidders row', 'authenticated', $q$INSERT INTO bidders (id, email, birth_date) VALUES (auth.uid(), 'x@example.test', '1990-01-01')$q$, :'e_deny');
SELECT pg_temp.t('bidder deletes own row', 'authenticated', $q$DELETE FROM bidders WHERE id = auth.uid()$q$, :'e_deny');
SELECT pg_temp.t('anon truncates bidders', 'anon', $q$TRUNCATE bidders CASCADE$q$, :'e_deny');
SELECT pg_temp.t('bidder clears own fees unpaid (old rpc)', 'authenticated', $q$SELECT clear_paid_relot_fees('fake')$q$, :'e_deny');
SELECT pg_temp.t('bidder calls new clear rpc', 'authenticated', $q$SELECT clear_relot_fees_for_bidder(auth.uid(), 'fake')$q$, :'e_deny');
SELECT pg_temp.t('bidder adds fee via apply_relot_fee', 'authenticated', $q$SELECT apply_relot_fee(gen_random_uuid(), 500)$q$, :'e_deny');
SELECT pg_temp.t('bidder sets ZIP via rpc', 'authenticated', $q$SELECT set_my_postal_code('72601')$q$, :'e_ok');
SELECT pg_temp.t('bidder snoozes ZIP prompt via rpc', 'authenticated', $q$SELECT snooze_my_postal_code_prompt()$q$, :'e_ok');
SELECT pg_temp.t('staff (service_role) approves tax_exempt', 'service_role', $q$UPDATE bidders SET tax_exempt = true, resale_cert_status = 'approved' WHERE id = '00000000-0000-0000-0000-0000000000b2'$q$, 'ok');
SELECT pg_temp.t('staff (service_role) waives fees', 'service_role', $q$UPDATE bidders SET unpaid_fees_cents = 0 WHERE id = '00000000-0000-0000-0000-0000000000b2'$q$, 'ok');
SELECT pg_temp.t('server clears fees after payment (new rpc)', 'service_role', $q$SELECT clear_relot_fees_for_bidder('00000000-0000-0000-0000-0000000000b1', 'sq_payment_id')$q$, :'e_new');
SELECT 'state', (SELECT coalesce(display_name,'-') || '|' || coalesce(phone,'-') || '|' || tax_exempt || '|' || unpaid_fees_cents || '|' || coalesce(postal_code,'-') FROM bidders WHERE id = '00000000-0000-0000-0000-0000000000b1'),
 (SELECT count(*) FILTER (WHERE paid_at IS NULL) FROM bidder_fee_ledger);
