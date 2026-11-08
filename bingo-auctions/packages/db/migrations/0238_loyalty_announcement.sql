-- 0238 — one-time loyalty announcement email kind
--
-- Owner, 2026-07-06: tell existing bidders that Square store loyalty points
-- are now earnable/redeemable at BinGo Auctions, with an add-your-phone CTA
-- (loyalty accounts are phone-keyed). Same shape as the referral
-- announcement (0231): marketing kind, email-only (push drain skips it),
-- once-per-bidder-ever via outbox key 'loyannounce:{bidder_id}' — later
-- re-sends only reach new signups.
--
-- No BEGIN/COMMIT (ALTER TYPE ... ADD VALUE, mig-0167 pattern). Idempotent.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'loyalty_announcement';
