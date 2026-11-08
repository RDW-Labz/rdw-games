import { describeWarehousePickup, type WarehousePickupSource } from '@/lib/warehouse-pickup';

/** True when the warehouse row has a non-empty customer notice (off-site sale). */
export function isWarehouseOffSite(warehouse: WarehousePickupSource | null | undefined): boolean {
  return describeWarehousePickup(warehouse ?? null).isOffsite;
}
