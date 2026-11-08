-- 0451 — sq-ft bidding, PR 1/11: schema only. `auctions.bid_mode`,
-- `auctions.unit_start_cents`, `lots.unit_qty`, `lots.unit_label`. No
-- behaviour change: nothing reads these columns yet.
--
-- WHY
--   Jared's request: tile/flooring pallets bid per square foot, whole pallet
--   still sold as one lot. Spec + gap analysis: docs/state/SQFT-BIDDING-SPEC.md
--   (branch docs/sqft-bidding-spec, PR #473). PR order: docs/specs/sqft-bidding-pr-list.md
--   (branch docs/live-edit-spec-and-sqft-prs). This is PR 1 of 11.
--   Architecture (owner, Braden): every bid, max bid, increment and price
--   stored in the database stays the TOTAL pallet amount in cents — same as
--   today. Per-unit is display and entry only: out = total ÷ unit_qty,
--   in = total = per-unit × unit_qty. Closing, invoice build, payment, pickup
--   and refund code are untouched (they already work on totals only).
--
-- WHAT
--   1. auctions.bid_mode text NOT NULL DEFAULT 'standard', CHECK IN
--      ('standard','per_unit'). Every existing and new-by-default auction is
--      'standard' — byte-identical behaviour.
--   2. auctions.unit_start_cents integer NULL, CHECK (NULL or > 0). Owner
--      decision 2026-10-26: starting price is per lot, with an auction-level
--      DEFAULT each lot can override. This is that default — the per-unit
--      starting price in cents (e.g. 10 = $0.10/sq ft) a per_unit auction's
--      builder (PR 6) offers, and assign (PR 4) applies to a lot that doesn't
--      set its own starting_bid_cents. NULL for every standard auction.
--   3. lots.unit_qty integer NULL, CHECK (NULL or > 0). The quantity a
--      per_unit lot's total divides into (e.g. 247 square feet). NULL for
--      every standard lot.
--   4. lots.unit_label text NULL, CHECK (NULL, or 1–20 btrim'd characters).
--      What the unit is called ('sq ft'). NULL for every standard lot.
--   Cross-table rules — a per_unit auction's lots must carry unit_qty, a
--   per_unit lot's starting bid and increments must be whole multiples of
--   unit_qty, a lot's own starting_bid_cents overrides unit_start_cents ×
--   unit_qty, assign/relist must match mode — are NOT enforced here. They
--   land in PR 4 (DB guards: lock trigger, assign, relist) and PR 6 (builder).
--   The bidding math lands in PR 3 (engine: 3-arg place_bid). Until then
--   unit_qty / unit_label / unit_start_cents can be set to anything (or left
--   NULL) and nothing reads them: no function, view, trigger or RLS policy in
--   this migration or any earlier one references bid_mode, unit_qty,
--   unit_label or unit_start_cents.
--
-- ── GRANTS (checked, not changed) ───────────────────────────────────────────
--   lots and auctions carry Supabase's TABLE-level default grants to anon and
--   authenticated (SELECT/INSERT/UPDATE/DELETE/...), gated entirely by RLS
--   (0002_rls.sql) — unlike bidders, which 0435 narrowed to per-COLUMN grants
--   after a real bidder-writable-column problem. No migration has ever done
--   that to lots or auctions (0440's own revoke list is 18 other RLS-locked,
--   policy-less tables and explicitly excludes lots/bids/invoices). So:
--     SELECT: table-level grants apply to every column automatically,
--       including these four. Bidders/anon already read lots and auctions
--       directly (lots_bidder_read_published / auctions_bidder_read_published,
--       SELECT only, published statuses) — the new columns are visible on the
--       same rows as everything else, same as any prior additive column.
--     WRITE: lots_staff_all / auctions_staff_all is `FOR ALL USING
--       (operator_id = current_operator_id()) WITH CHECK (same)`, and
--       current_operator_id() is NULL for any caller with no operator_users
--       row (every bidder, every anon session) — so WITH CHECK NULL = NULL is
--       never true. A bidder's table-level UPDATE grant already cannot write
--       ANY column of ANY row today; four more columns under the same
--       policy open no new path. No GRANT/REVOKE statement is needed or
--       included.
--
-- ── LOCKS (Rule 9) ───────────────────────────────────────────────────────────
--   ALTER TABLE takes a brief ACCESS EXCLUSIVE lock on auctions (two columns,
--   back-to-back statements, same transaction — one effective lock window),
--   then on lots (every bid, lot read and the storefront hit both tables).
--   auctions.bid_mode has a literal (non-volatile) DEFAULT 'standard' on a NOT
--   NULL column — PG11+ makes this metadata-only (no table rewrite): the
--   default is stored in pg_attribute and back-filled lazily on read, not
--   written row-by-row. auctions.unit_start_cents and lots.unit_qty /
--   unit_label are NULL-default, nullable columns — always metadata-only.
--   VALIDATE CONSTRAINT takes a less-restrictive SHARE UPDATE EXCLUSIVE lock
--   and does one read pass per table (auctions: a few hundred rows, twice;
--   lots: ~40k) — reads, not rewrites, measured on the rig below.
--   lock_timeout 3s: if a long transaction holds either table, this fails
--   fast instead of queueing every bid/read behind it — just rerun.
--   Window: 05:00–07:00 CT.
--
-- Rollback: scripts/prod-rig/0451_ROLLBACK_sqft_bid_mode_unit_qty.sql
--   (drops the four columns and their CHECKs; same lock profile, same window).

SET lock_timeout = '3s';

BEGIN;

-- ── 1. auctions.bid_mode ─────────────────────────────────────────────────────

ALTER TABLE public.auctions
  ADD COLUMN IF NOT EXISTS bid_mode text NOT NULL DEFAULT 'standard';

ALTER TABLE public.auctions
  DROP CONSTRAINT IF EXISTS auctions_bid_mode_check,
  ADD CONSTRAINT auctions_bid_mode_check
    CHECK (bid_mode IN ('standard', 'per_unit')) NOT VALID;

ALTER TABLE public.auctions VALIDATE CONSTRAINT auctions_bid_mode_check;

COMMENT ON COLUMN public.auctions.bid_mode IS
  '0451: ''standard'' (default, today''s behaviour) or ''per_unit'' (bid by '
  'the square foot etc.). Stored amounts are ALWAYS the total pallet price in '
  'cents either way — per-unit is a display/entry convenience computed as '
  'total ÷ lots.unit_qty, never stored. Lock-once-live and the per_unit '
  'engine rules (whole-multiple starting bid/increments, lot/auction mode '
  'match on assign and relist) are enforced starting PR 4; this migration '
  'adds no trigger, so bid_mode can currently be set to ''per_unit'' on any '
  'auction at any status with no other effect — nothing reads it yet.';

-- ── 2. auctions.unit_start_cents ─────────────────────────────────────────────

ALTER TABLE public.auctions
  ADD COLUMN IF NOT EXISTS unit_start_cents integer NULL;

ALTER TABLE public.auctions
  DROP CONSTRAINT IF EXISTS auctions_unit_start_cents_positive,
  ADD CONSTRAINT auctions_unit_start_cents_positive
    CHECK (unit_start_cents IS NULL OR unit_start_cents > 0) NOT VALID;

ALTER TABLE public.auctions VALIDATE CONSTRAINT auctions_unit_start_cents_positive;

COMMENT ON COLUMN public.auctions.unit_start_cents IS
  '0451: per_unit auctions only — the default starting price per unit, in '
  'cents (e.g. 10 = $0.10/sq ft). A lot''s own starting_bid_cents (a whole '
  'multiple of its unit_qty) overrides this default; enforced/applied '
  'starting PR 4 (assign sets starting_bid_cents = unit_start_cents × '
  'unit_qty when the lot has none of its own) and offered in PR 6''s builder. '
  'NULL for every standard auction. Nothing reads it yet.';

-- ── 3. lots.unit_qty ─────────────────────────────────────────────────────────

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS unit_qty integer NULL;

ALTER TABLE public.lots
  DROP CONSTRAINT IF EXISTS lots_unit_qty_positive,
  ADD CONSTRAINT lots_unit_qty_positive
    CHECK (unit_qty IS NULL OR unit_qty > 0) NOT VALID;

ALTER TABLE public.lots VALIDATE CONSTRAINT lots_unit_qty_positive;

COMMENT ON COLUMN public.lots.unit_qty IS
  '0451: the quantity a per_unit lot''s total price divides into (e.g. 247 '
  'square feet on a tile pallet). NULL for every standard lot. The engine '
  '(PR 3) requires a per_unit auction''s lots to carry a positive unit_qty '
  'and every stored amount (starting bid, increments, max bids) to be a '
  'whole multiple of it, so per-unit = total ÷ unit_qty is always a whole '
  'number of cents; this migration does not enforce that yet. No lock on '
  'edits after a lot goes live or takes a bid until PR 4''s trigger ships.';

-- ── 4. lots.unit_label ───────────────────────────────────────────────────────

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS unit_label text NULL;

ALTER TABLE public.lots
  DROP CONSTRAINT IF EXISTS lots_unit_label_length,
  ADD CONSTRAINT lots_unit_label_length
    CHECK (unit_label IS NULL OR length(btrim(unit_label)) BETWEEN 1 AND 20) NOT VALID;

ALTER TABLE public.lots VALIDATE CONSTRAINT lots_unit_label_length;

COMMENT ON COLUMN public.lots.unit_label IS
  '0451: what unit_qty counts, e.g. ''sq ft''. 1-20 trimmed characters, or '
  'NULL for every standard lot. Display-only — the engine (PR 3) never reads '
  'the label, only unit_qty. Deliberately NOT cross-checked against unit_qty '
  'here (e.g. "set together or not at all") even though a same-row CHECK '
  'could do that: PR 4 enforces it alongside the other per_unit rules '
  '(auction mode match, lock-once-live) in one place, with one error code, '
  'instead of splitting it across this migration and that one.';

COMMIT;
