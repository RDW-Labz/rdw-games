-- Rollback for 0411_crandall_warehouse.sql — standby only.
-- Deletes the Crandall row ONLY while nothing references it (no bins, lots,
-- auctions, pickups). Once anything does, deactivate instead:
--   UPDATE public.warehouses SET active = false WHERE name = 'Crandall';
BEGIN;

DELETE FROM public.warehouses w
 WHERE w.name = 'Crandall'
   AND w.operator_id = (SELECT operator_id FROM public.warehouses
                         WHERE id = 'ce9646af-55b5-412b-bff1-b86a5cdd8b54')
   AND NOT EXISTS (SELECT 1 FROM public.bins     b WHERE b.warehouse_id = w.id)
   AND NOT EXISTS (SELECT 1 FROM public.lots     l WHERE l.warehouse_id = w.id)
   AND NOT EXISTS (SELECT 1 FROM public.auctions a WHERE a.warehouse_id = w.id)
   AND NOT EXISTS (SELECT 1 FROM public.pickups  p WHERE p.warehouse_id = w.id);

COMMIT;
