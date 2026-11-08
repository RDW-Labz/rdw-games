WITH op AS (SELECT id FROM operators WHERE slug='bingo-auctions'),
inv AS (SELECT i.* FROM invoices i, op WHERE i.operator_id=op.id AND i.created_at>=now()-interval '84 days' AND i.status::text <> 'canceled'),
seg AS (SELECT bidder_id, CASE WHEN count(*)>=60 THEN 'heavy60' WHEN count(*)>=10 THEN 'mid10_59' ELSE 'light' END s FROM inv GROUP BY 1)
SELECT json_agg(x) FROM (
SELECT seg.s, count(DISTINCT seg.bidder_id) buyers, count(il.*) lines, sum(il.winning_bid_cents) hammer_c, round(avg(il.winning_bid_cents)) avg_line_c,
 round(count(il.forfeited_at)::numeric/count(il.*),3) forfeit_rate, round(count(il.refunded_at)::numeric/count(il.*),3) refund_rate,
 (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.completed_at-i2.paid_at)/86400)::numeric,2) FROM pickups p JOIN inv i2 ON i2.id=p.invoice_id JOIN seg s2 ON s2.bidder_id=i2.bidder_id WHERE s2.s=seg.s AND p.completed_at IS NOT NULL) p50_pickup_days,
 (SELECT round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM p.completed_at-i2.paid_at)/86400)::numeric,2) FROM pickups p JOIN inv i2 ON i2.id=p.invoice_id JOIN seg s2 ON s2.bidder_id=i2.bidder_id WHERE s2.s=seg.s AND p.completed_at IS NOT NULL) p90_pickup_days,
 (SELECT count(DISTINCT date_trunc('day', p.completed_at)) FROM pickups p JOIN inv i2 ON i2.id=p.invoice_id JOIN seg s2 ON s2.bidder_id=i2.bidder_id WHERE s2.s=seg.s AND p.completed_at IS NOT NULL) pickup_days_total,
 (SELECT count(*) FROM (SELECT DISTINCT i2.bidder_id, date_trunc('day', p.completed_at AT TIME ZONE 'America/Chicago') FROM pickups p JOIN inv i2 ON i2.id=p.invoice_id JOIN seg s2 ON s2.bidder_id=i2.bidder_id WHERE s2.s=seg.s AND p.completed_at IS NOT NULL) t) visits
FROM seg JOIN inv ON inv.bidder_id=seg.bidder_id JOIN invoice_lots il ON il.invoice_id=inv.id GROUP BY seg.s) x
