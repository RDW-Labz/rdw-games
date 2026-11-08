import type { InventoryRowV2 } from './inventory-types';

/**
 * v1 InventoryTable's Location cell: "Warehouse · Bin X (Aisle A / Bay B)",
 * "—" when the lot has neither. The page already builds the bin half
 * (locationLabel, "—" when no bin); this joins the warehouse in front.
 */
export function inventoryLocationLabel(row: Pick<InventoryRowV2, 'warehouseName' | 'locationLabel'>): string {
  const parts: string[] = [];
  if (row.warehouseName) parts.push(row.warehouseName);
  if (row.locationLabel && row.locationLabel !== '—') parts.push(row.locationLabel);
  return parts.length > 0 ? parts.join(' · ') : '—';
}
