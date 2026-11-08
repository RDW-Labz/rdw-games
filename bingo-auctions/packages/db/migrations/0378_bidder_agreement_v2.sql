-- 0378 — publish Bidder Agreement version 2 (1.2 in the document header).
--
-- Adds §3.5 Withdrawn lots ("BinGo may withdraw a lot before it closes. Bids on
-- a withdrawn lot are void and no one is charged. If a withdrawn lot was
-- already paid for, it's refunded in full.") and rewords §3.4 so it no longer
-- says no staff member can remove a live bid.
--
-- What a new row does: get_active_policy_versions() (latest published by
-- effective_at) returns version 2, so NEW signups record consent to v2.
-- Existing bidders are NOT asked again: the bidder agreement is accepted only
-- at signup. Re-acceptance before a bid comes from the seller policy (0379).
--
-- ORDER: deploy the website first. The page's text is bundled at build time
-- (scripts/generate-legal-content.mjs); applying this before the deploy would
-- have new signups record v2 while reading v1.
--
-- content_hash = SHA-256 of legal/bidder-agreement.md as committed with this
-- migration (legal/README.md, Publish gate). v1 stays as history.
--
-- Rollback: UPDATE policy_versions SET published = false
--           WHERE slug = 'bidder-agreement' AND version = 2;

INSERT INTO public.policy_versions (slug, version, content_hash, effective_at, published)
VALUES ('bidder-agreement', 2, '0a75ff7884b3da5459637ff1e6eb97e959233052baf8a0d830b4d7c545c31bfb', now(), true)
ON CONFLICT DO NOTHING;
