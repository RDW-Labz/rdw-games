-- Which row each scan resolves to, and who staff_scan_lot_owner names.
-- Printed as stable lines so run.sh can diff BEFORE vs AFTER.
\set ON_ERROR_STOP 1
\pset tuples_only on
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');
SELECT 'SCAN ' || c || ' -> ' || coalesce((public._find_lot_by_scan(ARRAY[c])->'lot'->>'lot_code'), 'none')
         || ' | owner ' || coalesce((public.staff_scan_lot_owner(ARRAY[c])->'owner'->>'bidder_name'), 'none')
         || ' | ' || coalesce((public.staff_scan_lot_owner(ARRAY[c])->'owner'->>'invoice_status'), '-')
  FROM unnest(ARRAY['TEA4842561', 'RGV:TEA4842561', 'OLD1', 'NEW1', 'TEA0000002', 'OLD2', 'TEA0000003', 'OLD3', 'TEA0000004', 'OLD4']) c;
