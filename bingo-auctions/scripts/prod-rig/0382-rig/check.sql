\pset format unaligned
\pset tuples_only on
SELECT 'STATE ' || k || ' n=' || count(*) FROM (SELECT status || ' shelf=' || (intake_bin_id IS NOT NULL) || ' auction=' || (auction_id IS NOT NULL) || ' lot_number=' || (lot_number IS NOT NULL) || ' close_at=' || (close_at IS NOT NULL) || ' intake_at=' || (intake_at IS NOT NULL) AS k FROM lots WHERE lot_code LIKE 'RIGC-%') x GROUP BY k ORDER BY 1;
SELECT 'CAPTURED ' || coalesce((SELECT target_status || '=' || count(*) FROM public._stranded_closed_auction_drafts_20260930 GROUP BY target_status ORDER BY 1 LIMIT 1),'none') || ' / ' || coalesce((SELECT target_status || '=' || count(*) FROM public._stranded_closed_auction_drafts_20260930 GROUP BY target_status ORDER BY 1 OFFSET 1 LIMIT 1),'none');
SELECT 'DISPOSED_UNTOUCHED ' || (status = 'disposed' AND auction_id IS NOT NULL AND lot_number = 10) FROM lots WHERE lot_code = 'RIGC-009';
