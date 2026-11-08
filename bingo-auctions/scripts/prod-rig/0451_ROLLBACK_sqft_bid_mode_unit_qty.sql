-- Rollback for 0451_sqft_bid_mode_unit_qty.sql — standby only.
--
-- Safe any time nothing reads these columns yet (true through at least PR 3 /
-- PR 4). If PR 2+ has shipped and a per_unit auction exists, export first —
-- dropping the columns deletes every lot's unit_qty / unit_label and every
-- auction's bid_mode / unit_start_cents:
--   SELECT id, bid_mode, unit_start_cents FROM public.auctions WHERE bid_mode <> 'standard' OR unit_start_cents IS NOT NULL;
--   SELECT id, unit_qty, unit_label FROM public.lots WHERE unit_qty IS NOT NULL;
--
-- Locks: DROP COLUMN / DROP CONSTRAINT take a brief ACCESS EXCLUSIVE lock on
-- auctions, then lots (metadata-only, no rewrite). Window: 05:00–07:00 CT, or
-- any hour if 0451 is actively breaking something (it shouldn't — nothing
-- reads these columns).

SET lock_timeout = '3s';

BEGIN;

ALTER TABLE public.lots
  DROP CONSTRAINT IF EXISTS lots_unit_label_length,
  DROP CONSTRAINT IF EXISTS lots_unit_qty_positive,
  DROP COLUMN IF EXISTS unit_label,
  DROP COLUMN IF EXISTS unit_qty;

ALTER TABLE public.auctions
  DROP CONSTRAINT IF EXISTS auctions_unit_start_cents_positive,
  DROP CONSTRAINT IF EXISTS auctions_bid_mode_check,
  DROP COLUMN IF EXISTS unit_start_cents,
  DROP COLUMN IF EXISTS bid_mode;

COMMIT;
