-- 0436 — keep a saved card's billing ZIP as the bidder's ZIP, only if they have none.
--
-- WHAT
--   public.fill_bidder_postal_code_if_empty(p_bidder_id uuid, p_postal_code text)
--   RETURNS boolean. Called by operator-web's card-save route
--   (POST /api/bidder/square/save-card) with the service-role client, right
--   after Square's CreateCard succeeds and the card is stored, passing
--   card.billing_address.postal_code.
--     - Normalises: a US ZIP '12345' or ZIP+4 '12345-6789' (surrounding
--       whitespace ignored) becomes the first 5 digits. Anything else (NULL,
--       blank, non-US formats) returns false and writes nothing.
--     - Fills bidders.postal_code ONLY where it IS NULL and the account is not
--       deleted (deleted_at IS NULL). A ZIP the bidder set themselves is never
--       overwritten. Sets postal_code_updated_at = now().
--     - Returns true only when a row changed.
--     - Each fill writes one operator_audit_log row: action_type
--       'bidder.postal_code_from_card', target_id = the bidder,
--       before_state {postal_code: null}, after_state {postal_code,
--       postal_code_updated_at}, actor_user_id NULL (a system write the
--       bidder's card save triggered). Same shape as PR #542's backfill.
--
-- WHY
--   Owner-approved 2026-10-21. bidders.postal_code (0434) is used to plan
--   auctions near where bidders live. Square's card form (payments.card() in
--   SquareCardForm.tsx) already asks for the billing ZIP, and CreateCard returns
--   it on card.billing_address.postal_code; createCardOnFile used to drop it.
--   This keeps it, and never replaces a ZIP the bidder gave.
--
-- PRIVACY (approved by legal in PR #543, legal/privacy.md line 27)
--   "If you have not given us a ZIP code, we also copy the 5-digit billing ZIP
--   code you entered with your card from Square and save it as your account
--   ZIP code. You can change it in your profile."
--   Account deletion clears the ZIP (0434's guard trigger).
--
-- operator_id ON THE AUDIT ROW
--   operator_audit_log.operator_id is NOT NULL, but bidders are global accounts
--   on a single-operator platform (0434 header). Resolved the way PR #542's
--   backfill script checks it: the BinGo operator by code, operators.code =
--   'BIN' (operators_code_unique, 0021). No uuid is hard-coded, so the function
--   behaves the same on any copy of the database. If there is no 'BIN'
--   operator the function returns false and writes nothing: no ZIP without its
--   audit row.
--
-- WHO MAY WRITE
--   0434's bidders_postal_code_guard refuses direct writes to postal_code from
--   anon / authenticated / service_role (it checks current_user). This function
--   is SECURITY DEFINER, so inside it current_user is the owner (postgres) and
--   the guard lets the write through. Proven in
--   scripts/__tests__/fill-bidder-zip-0436.test.mjs.
--   EXECUTE: service_role only; revoked from PUBLIC, anon, authenticated. A
--   bidder changes their own ZIP with 0434's set_my_postal_code().
--
-- ORDER
--   After 0434 (bidders.postal_code, postal_code_updated_at, the guard) and
--   0435 (PR #544). Then the operator-web deploy that calls it. Until the
--   function exists the route ignores the PGRST202 / 42883 error.
--
-- LOCKS (Rule 9)
--   CREATE FUNCTION only; no lock on bidders. lock_timeout 3s anyway.
--   Window: 05:00–07:00 CT with the other DB steps.
--
-- Rollback: scripts/prod-rig/0436_ROLLBACK_fill_bidder_postal_code_from_card.sql
--   (DROP FUNCTION), then revert the operator-web change (or leave it: it
--   ignores a missing function). ZIPs already filled stay; each one is listed
--   in operator_audit_log (action_type 'bidder.postal_code_from_card').

SET lock_timeout = '3s';

BEGIN;

CREATE OR REPLACE FUNCTION public.fill_bidder_postal_code_if_empty(
  p_bidder_id   uuid,
  p_postal_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_raw   text := btrim(coalesce(p_postal_code, ''), E' \t\r\n');
  v_zip   text;
  v_op    uuid;
  v_stamp timestamptz := now();
  v_id    uuid;
BEGIN
  IF p_bidder_id IS NULL OR v_raw !~ '^[0-9]{5}(-[0-9]{4})?$' THEN
    RETURN false;
  END IF;
  v_zip := left(v_raw, 5);

  SELECT o.id INTO v_op FROM operators o WHERE o.code = 'BIN';
  IF v_op IS NULL THEN
    RETURN false;
  END IF;

  UPDATE bidders b
     SET postal_code = v_zip,
         postal_code_updated_at = v_stamp
   WHERE b.id = p_bidder_id
     AND b.postal_code IS NULL
     AND b.deleted_at IS NULL
  RETURNING b.id INTO v_id;

  IF v_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES
    (v_op, NULL, 'bidder.postal_code_from_card', v_id,
     jsonb_build_object('postal_code', NULL),
     jsonb_build_object('postal_code', v_zip, 'postal_code_updated_at', v_stamp),
     'Billing ZIP from a saved Square card (0436)');

  RETURN true;
END;
$function$;

COMMENT ON FUNCTION public.fill_bidder_postal_code_if_empty(uuid, text) IS
  '0436: set bidders.postal_code from a saved card''s billing ZIP (US 5-digit or '
  'ZIP+4 -> 5 digits) only when the bidder has none and is not deleted. True if a '
  'row changed; one operator_audit_log ''bidder.postal_code_from_card'' row per '
  'fill. service_role only.';

REVOKE ALL ON FUNCTION public.fill_bidder_postal_code_if_empty(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fill_bidder_postal_code_if_empty(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fill_bidder_postal_code_if_empty(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fill_bidder_postal_code_if_empty(uuid, text) TO service_role;

COMMIT;
