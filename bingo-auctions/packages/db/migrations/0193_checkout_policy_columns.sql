-- ============================================================================
-- 0193_checkout_policy_columns.sql
--
-- Checkout improvements CHK-01 / CHK-02 — adds three operator-configurable
-- columns to operator_policies so operators can tune the staff pickup-verify
-- flow (apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx).
--
-- IMPORTANT — operator_policies IS VERSIONED. There is one row per published
-- policy version (PRIMARY KEY (operator_id, version), mig 0088). Historical
-- versions that bidders have already accepted are read back unchanged, so
-- EVERY new column MUST be NOT NULL with a DEFAULT — otherwise a read of an
-- older version (or any code path that selects these columns from a pre-0193
-- row) would surface NULL and break callers. The defaults below are chosen to
-- preserve today's effective behavior exactly:
--
--   require_identity_check          BOOL DEFAULT true  — CHK-01: today the
--     'confirm_id' step is always forced. Default TRUE keeps it always-on.
--   identity_check_threshold_cents  INT  DEFAULT 0     — CHK-01: 0 = always
--     require the identity step (today's behavior). >0 = only require it when
--     the invoice total is >= the threshold (small handoffs skip it).
--   require_signature               BOOL DEFAULT false — CHK-02: signature is
--     already skippable in the UI ("Skip signature — confirm now"). Default
--     FALSE takes the signature step out of the standard flow; operators that
--     want it back flip this to TRUE.
--
-- PURE ADDITIVE. Does not touch existing policy columns. Plain statements (no
-- BEGIN/COMMIT) so the CI migration runner can apply each idempotently; this
-- file does NOT self-mark schema_migrations.
-- ============================================================================

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS require_identity_check BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS identity_check_threshold_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.operator_policies
  ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;

-- Column comments document intent for future readers and Supabase Studio.

COMMENT ON COLUMN public.operator_policies.require_identity_check IS
  'CHK-01. When TRUE (default), the staff pickup-verify flow forces the '
  '''confirm_id'' identity-confirmation step before lot verification. When '
  'FALSE, staff auto-advance from the bidder-QR scan straight to lot '
  'verification. Default TRUE preserves the pre-0193 always-on behavior. '
  'Gated together with identity_check_threshold_cents.';

COMMENT ON COLUMN public.operator_policies.identity_check_threshold_cents IS
  'CHK-01. Invoice-total threshold (cents) above which the identity step is '
  'required. 0 (default) = always require when require_identity_check is TRUE '
  '(today''s behavior). >0 = only require the step when the invoice total is '
  '>= this many cents; smaller pickups skip identity confirmation. Ignored '
  'entirely when require_identity_check is FALSE. NOTE: there is no per-lot '
  '''cage''/''high_value'' attribute in the schema, so this gates on the '
  'invoice total only.';

COMMENT ON COLUMN public.operator_policies.require_signature IS
  'CHK-02. When TRUE, the staff pickup-verify flow presents the signature '
  'capture step and routes the primary CTA through it. When FALSE (default), '
  'the signature step is hidden and the primary CTA confirms the pickup '
  'directly (the existing "Skip signature — confirm now" path becomes the '
  'default). Default FALSE keeps signature out of the standard flow; signature '
  'is already optional in the UI today.';
