-- READ-ONLY lists for the owner (2026-10-28). No writes. Codes, dates,
-- amounts and warehouse only: no names, emails or bidder ids.
-- Run with: gh workflow run apply-migration.yml -f mode=query -f "sql=$(cat <this file, one statement at a time>)"
-- (mode=query takes one SELECT; run each block separately.)

-- A) The ~580 lots with a refunded invoice line that are still 'won'.
--    "would_move" = what the 0475 trigger rule would have done at refund
--    time (never picked up, not forfeited, not reported missing, no other
--    open sale). Only would_move = true rows are candidates for a later,
--    owner-approved batch to 'refunded'.
SELECT coalesce(l.sticker_code, l.lot_code) AS code, l.lot_code, w.name AS warehouse,
       to_char(il.refunded_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS refunded_on,
       il.winning_bid_cents AS hammer_cents,
       (il.picked_up_at IS NULL AND il.forfeited_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM pickup_lot_outcomes o JOIN pickups p ON p.id = o.pickup_id
                         WHERE p.invoice_id = il.invoice_id AND o.lot_id = l.id AND o.outcome = 'missing')
        AND NOT EXISTS (SELECT 1 FROM invoice_lots x JOIN invoices i ON i.id = x.invoice_id
                         WHERE x.lot_id = l.id AND x.invoice_id <> il.invoice_id AND x.refunded_at IS NULL
                           AND x.forfeited_at IS NULL AND i.status IN ('pending', 'paid', 'partially_refunded', 'payment_failed_grace'))
       ) AS would_move,
       CASE WHEN il.picked_up_at IS NOT NULL THEN 'picked up'
            WHEN il.forfeited_at IS NOT NULL THEN 'forfeited'
            ELSE '' END AS why_not,
       EXISTS (SELECT 1 FROM lots c WHERE c.relisted_from_lot_id = l.id AND c.deleted_at IS NULL) AS already_relisted
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  LEFT JOIN warehouses w ON w.id = l.warehouse_id
 WHERE il.refunded_at IS NOT NULL AND l.status = 'won' AND l.deleted_at IS NULL
 ORDER BY il.refunded_at DESC;

-- B) The 181 old relisted rows still on a declined-and-relisted invoice
--    (they show "Unpaid" / "Awaiting pickup" on old screens). Display-only;
--    #611/#612 fix how they read. Nothing to write.
SELECT l.lot_code, w.name AS warehouse, right(i.id::text, 8) AS invoice_last8,
       to_char(i.created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS invoiced_on,
       il.winning_bid_cents AS hammer_cents,
       (SELECT c.lot_code FROM lots c WHERE c.relisted_from_lot_id = l.id ORDER BY c.created_at DESC LIMIT 1) AS newer_row
  FROM lots l
  JOIN invoice_lots il ON il.lot_id = l.id
  JOIN invoices i ON i.id = il.invoice_id
  LEFT JOIN warehouses w ON w.id = l.warehouse_id
 WHERE l.status = 'relisted' AND l.deleted_at IS NULL AND i.status = 'payment_failed_relisted'
 ORDER BY i.created_at DESC;
