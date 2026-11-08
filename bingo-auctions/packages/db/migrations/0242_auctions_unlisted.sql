-- 0242 — unlisted (link-only) auctions
--
-- Owner, 2026-07-06: "can we make test auction not visible to public" —
-- needed for the pickup-pass live test (real wins in Jared's account on a
-- launched site). An unlisted auction:
--   • is hidden from every public discovery surface: browse (both tabs),
--    homepage rails, category pages, Final Call, search suggest, sitemap,
--    recent-wins ticker, marketing digest, saved-search alerts
--   • still works via DIRECT LINK (/auction/{id}, /lot/{code}) so invited
--     testers can view and bid — the bidding engine is untouched
--   • is fully visible in the operator console
--
-- Plain DDL, transactional, idempotent.

BEGIN;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS unlisted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN auctions.unlisted IS
  '0242: link-only auction — excluded from all public discovery surfaces '
  '(browse/home/category/final-call/search/sitemap/digest/recent-wins) but '
  'reachable by direct URL. Used for staff test auctions on the live site.';

COMMIT;
