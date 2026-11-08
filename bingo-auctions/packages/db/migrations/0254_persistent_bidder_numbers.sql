-- migration 0254 — persistent anonymous bidder numbers
--
-- Customer request 2026-07-09: on previous auction platforms every account
-- had ONE bidder number across all auctions — people knew their own number
-- and recognized friends/family, letting them avoid bidding each other up.
-- Our bid history labels were per-PAGE ("Bidder 1..N" by sorted bidder_id),
-- so the same person got a different number on every lot.
--
-- Design:
--   • bidders.bidder_number — permanent, unique, assigned once per account.
--     Backfilled by account creation order starting at #101 (skips the
--     low-number vanity range and avoids implying "Bidder 1" = first bid).
--   • New accounts draw from bidder_number_seq via column DEFAULT.
--   • bidder_public_numbers(uuid[]) RPC — SECURITY DEFINER lookup so the
--     bidder app (client-side, RLS blocks cross-bidder reads on `bidders`)
--     can label bid history. Exposes ONLY the pseudonymous number for ids
--     the caller already sees on bid rows; no name/email/contact fields.
--
-- Idempotent: guarded ADD COLUMN/backfill; CREATE OR REPLACE FUNCTION.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS bidder_number_seq START 101;

ALTER TABLE bidders ADD COLUMN IF NOT EXISTS bidder_number INTEGER UNIQUE;

-- Backfill existing accounts in signup order (only rows still NULL).
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM bidders
  WHERE bidder_number IS NULL
)
UPDATE bidders b
SET bidder_number = 100 + o.rn
FROM ordered o
WHERE b.id = o.id;

-- Move the sequence past everything assigned, then let new signups default.
SELECT setval(
  'bidder_number_seq',
  GREATEST((SELECT COALESCE(MAX(bidder_number), 100) FROM bidders), 100)
);
ALTER TABLE bidders ALTER COLUMN bidder_number SET DEFAULT nextval('bidder_number_seq');

COMMENT ON COLUMN bidders.bidder_number IS
  '0254: permanent anonymous public bidder number (shown as "Bidder #N" in '
  'bid history on every auction). Assigned at signup via bidder_number_seq; '
  'never reused or changed.';

-- Pseudonym lookup for client-side bid history (bidder app). Caller must be
-- authenticated; input ids come off bid rows the caller can already read.
CREATE OR REPLACE FUNCTION bidder_public_numbers(p_bidder_ids UUID[])
RETURNS TABLE (bidder_id UUID, bidder_number INTEGER)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT b.id, b.bidder_number
  FROM bidders b
  WHERE b.id = ANY(p_bidder_ids)
    AND auth.uid() IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION bidder_public_numbers(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bidder_public_numbers(UUID[]) TO authenticated;

COMMENT ON FUNCTION bidder_public_numbers(UUID[]) IS
  '0254: id → permanent anonymous bidder number, for labeling bid history '
  'client-side. Returns no identity fields.';

COMMIT;
