-- 0262 — one-off data repair: attach pre-0261 orphaned wins to their winner's
-- paid invoice as $0 comp lines (Option C — freebie, no extra charge).
--
-- Companion to 0261, which fixed the CAUSE (invoices built mid-auction could be
-- paid before a bidder's later lots closed, permanently orphaning them). This
-- repairs the lots already orphaned before that fix landed.
--
-- INCIDENT (2026-07-13): 4 lots were won but never attached to any invoice, so
-- the app showed them as "UNPAID · PENDING" to the customer:
--   grand opening — childcraft Redmond, BEDELITE quilt (Alexa Ruimy),
--                   Anti-Barking (david.ritter1986)
--   Bid Bid BinGo — Convertible 2-in-1 crib (Tammie Ply)
--
-- DECISION (operator, 2026-07-13): Option C — let the winners keep these as
-- freebies (physical items handed over on their existing pickup). We attach
-- each orphan to that winner's EXISTING PAID invoice for the same auction, at
-- winning_bid_cents = 0:
--   • the lot now joins a paid invoice → the app shows "Paid · Awaiting pickup"
--     instead of "Unpaid · Pending";
--   • it rides the customer's existing pickup for that auction;
--   • $0 means no additional charge and no change to the already-captured
--     invoice total (build_invoices_for_auction won't touch a paid invoice).
--
-- Self-limiting: only lots that are (won, have NO invoice_lot, closed >2h ago,
-- and whose winner has a PAID invoice for the same auction) are affected — i.e.
-- exactly the orphan condition. Idempotent via the LEFT JOIN guard + the
-- (invoice_id, lot_id) primary key. Excludes the throwaway "Test Auction .11".

BEGIN;

INSERT INTO public.invoice_lots (invoice_id, lot_id, winning_bid_cents)
SELECT i.id, l.id, 0
FROM public.lots l
JOIN public.auctions a ON a.id = l.auction_id
JOIN public.invoices i
  ON i.auction_id = l.auction_id
 AND i.bidder_id = l.winner_bidder_id
 AND i.status = 'paid'
LEFT JOIN public.invoice_lots il ON il.lot_id = l.id
WHERE l.winner_bidder_id IS NOT NULL
  AND l.status = 'won'
  AND il.lot_id IS NULL
  AND l.close_at < now() - interval '2 hours'
  AND a.title <> 'Test Auction .11'
ON CONFLICT (invoice_id, lot_id) DO NOTHING;

COMMIT;
