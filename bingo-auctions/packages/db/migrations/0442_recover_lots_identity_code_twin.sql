-- 0442 — RECOVER the live "identity-code twin" INSERT guard into the repo
--
-- ⚠️ REPO/PROD DRIFT (found 2026-10-21, issue #551): prod trigger
-- `lots_block_identity_code_twin_trg` on `public.lots` (BEFORE INSERT, ENABLED)
-- and its function `public.lots_block_identity_code_twin()` are LIVE and
-- enforcing today, but no migration in this repo creates them. They were
-- part of mig 0275 (PR #207, "kill the duplicate-lot machine", D3's
-- create-time gate), which reached prod 2026-07-16 23:51 but — like the rest
-- of 0275/0276 — was never committed. 0285 later recovered 0275's OTHER half
-- (`relist_lot_into_auction`'s active-child guard) under the same drift, but
-- left this trigger as a follow-up (0285's header: "0273, 0274 and 0276 are
-- still missing ... Recover them the same way ... when their exact bodies are
-- available"). This file is that recovery for the trigger half. A from-scratch
-- rebuild of this repo currently mints lots with NO defense against a Quick
-- Lot scan reusing a legacy label (lot_code/legacy_lot_code) that already
-- identifies another active lot — exactly the D3 defect 0275 closed on prod.
--
-- ── PROD CHECK (read via pg_get_functiondef / pg_get_triggerdef, 2026-10-21,
--    catalog-only, read-only query workflow — Rule 1) ─────────────────────
--   • public.lots_block_identity_code_twin(): LANGUAGE plpgsql, RETURNS
--     trigger, prosecdef = false (NOT SECURITY DEFINER — same as 0275's
--     original), proconfig = NULL (no SET search_path — same as 0275's
--     original), owner = postgres. Body is BYTE-IDENTICAL to 0275's proposed
--     definition (PR #207 diff), modulo pg_get_functiondef's cosmetic
--     normalization (schema-qualifies the name, uses a $function$ tag instead
--     of $$). No drift on this half — unlike relist_lot_into_auction /
--     admin_cancel_lot, which DID drift and needed 0285 / 0291 to reconcile.
--   • Trigger: `CREATE TRIGGER lots_block_identity_code_twin_trg BEFORE
--     INSERT ON public.lots FOR EACH ROW EXECUTE FUNCTION
--     lots_block_identity_code_twin()` — tgenabled = 'O' (origin/local,
--     i.e. normally enabled).
--   • Grants: {postgres, anon, authenticated, service_role, PUBLIC} all carry
--     EXECUTE — Postgres' default ACL for a freshly created function, never
--     narrowed. This is fine and is NOT restated below: the function
--     RETURNS trigger, so Postgres itself refuses any direct invocation
--     (`SELECT lots_block_identity_code_twin()` errors
--     "trigger functions can only be called as triggers") regardless of who
--     holds EXECUTE — the same reasoning `scripts/check-function-grants.cjs`
--     already codifies as its RETURNS-trigger exemption. CREATE OR REPLACE
--     preserves whatever ACL is already on prod either way (0295's rationale
--     for the same non-restatement).
--   • Dependencies: `lots.operator_id`, `.status` (lot_status, which already
--     carries 'canceled' from 0001 and 'disposed' from 0146), `.lot_code`,
--     `.external_code`, `.legacy_lot_code`, `.deleted_at`, `.canceled_at`,
--     `.relisted_from_lot_id` all exist and predate this file by hundreds of
--     migrations (0001/0023/0042/0097/0103/0146) — nothing else is called.
--     Confirmed present with matching types on prod via information_schema.
--
-- ── NOT RECOVERED HERE (scope note) ─────────────────────────────────────────
-- 0275 also added a matching bind-time check inside `claim_sticker_code`
-- (reason `code_belongs_to_existing_lot` on an attempted REBIND of an
-- existing lot to another active lot's legacy code). Checked live on prod
-- 2026-10-21: `claim_sticker_code`'s current body does NOT contain that
-- check — it is NOT live today, so it is NOT restored by this file. Only the
-- CREATE-time guard (this trigger) is recovered here; the bind-time guard
-- stayed missing on prod itself and is out of scope for a drift-recovery
-- migration, which only re-commits what is ALREADY deployed.
--
-- ── LOCK NOTE ────────────────────────────────────────────────────────────
-- CREATE OR REPLACE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on `lots`
-- (blocks writers, not readers). On prod it replaces the identical, already
-- live definition in place. lock_timeout 3s bounds the wait, so apply it in
-- the 05:00-07:00 CT window (Rule 9: database locks on lots).
--
-- ── LINT NOTE ────────────────────────────────────────────────────────────
-- No DO block: a plain CREATE OR REPLACE TRIGGER (PG14+, prod is 17.6) is
-- idempotent on its own, and scripts/check-new-lot-migrations.cjs reports 0
-- errors for it (a DO block holding CREATE TRIGGER trips its non-waivable
-- dynamic-EXECUTE rule).
--
-- Idempotent by construction: CREATE OR REPLACE re-states the same trigger, so
-- running this file twice (prod or empty DB) leaves exactly one trigger.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.lots_block_identity_code_twin()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_existing_code TEXT;
BEGIN
  -- Only legacy-label-shaped codes (letters then digits, e.g. GRA4015187,
  -- BRN4338003, TEA4840030) can be lot identities. UPCs/EANs (all digits),
  -- ASINs (B0…), FNSKUs (X00…) never match the shape, and the equality test
  -- means we only ever block a code that literally IS an existing active
  -- lot's lot_code/legacy_lot_code for this operator. Mig 0058's rule that
  -- identical PRODUCTS are separate legit lots is untouched.
  IF NEW.external_code IS NOT NULL
     AND NEW.external_code ~ '^[A-Za-z]{2,8}[0-9]{3,}$' THEN
    SELECT l.lot_code INTO v_existing_code
      FROM lots l
     WHERE l.operator_id = NEW.operator_id
       AND l.canceled_at IS NULL
       AND l.deleted_at IS NULL
       AND l.status NOT IN ('canceled', 'disposed')
       AND (upper(l.lot_code) = upper(NEW.external_code)
            OR upper(l.legacy_lot_code) = upper(NEW.external_code))
       AND (NEW.relisted_from_lot_id IS NULL OR l.id <> NEW.relisted_from_lot_id)
     LIMIT 1;
    IF v_existing_code IS NOT NULL THEN
      RAISE EXCEPTION
        'code_belongs_to_existing_lot: % is already the identity of active lot % — open that lot (or relist it) instead of creating a new one',
        NEW.external_code, v_existing_code
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.lots_block_identity_code_twin() IS
  '0275 (recovered into repo by 0442): BEFORE INSERT guard on lots. Refuses '
  'an INSERT whose external_code equals an active lot''s lot_code/'
  'legacy_lot_code (legacy label shape, same operator; the INSERT''s own '
  'relist parent is exempt) — closes the "scan a legacy sticker in Quick '
  'Lot, mint a twin" path client-independently. See 0275 / PR #207 / #551.';

-- Trigger: CREATE OR REPLACE TRIGGER (PG14+; prod is 17.6) is idempotent with
-- no DO block. On prod it replaces the identical definition in place; it takes
-- a brief SHARE ROW EXCLUSIVE lock on lots, bounded by lock_timeout 3s, so
-- apply it in the 05:00-07:00 CT window.
CREATE OR REPLACE TRIGGER lots_block_identity_code_twin_trg
  BEFORE INSERT ON public.lots
  FOR EACH ROW
  EXECUTE FUNCTION lots_block_identity_code_twin();

COMMIT;
