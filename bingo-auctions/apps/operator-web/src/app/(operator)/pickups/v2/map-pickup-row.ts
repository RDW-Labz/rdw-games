import { warehouseTimezone } from '@/lib/datetime';
import { customerLabel, invoiceShortId } from '../counter-rows';
import type { CounterRowDetailV2, PickupRowV2 } from './pickup-types';

type CounterDetailsMap = Map<string, { customerLabel: string; owed: CounterRowDetailV2['owed'] }>;

export function mapPickupRow(
  p: Record<string, unknown>,
  counterDetails?: CounterDetailsMap,
): PickupRowV2 {
  const inv = p.invoices as {
    status?: string;
    bidder_id?: string;
    bidders?: { email?: string | null; display_name?: string | null };
  } | null;
  const wh = p.warehouses as { name?: string; timezone?: string } | null;
  const tz = warehouseTimezone(wh);
  const pickupId = p.id as string;
  const counterRow = counterDetails?.get(pickupId);
  const bidder = inv?.bidders;

  return {
    id: pickupId,
    status: (p.status as string) ?? 'pending',
    scheduledAt: (p.scheduled_at as string | null) ?? null,
    checkedInAt: (p.checked_in_at as string | null) ?? null,
    completedAt: (p.completed_at as string | null) ?? null,
    invoiceId: p.invoice_id as string,
    warehouseName: wh?.name ?? null,
    warehouseTimezone: tz ?? 'UTC',
    invoiceStatus: inv?.status ?? null,
    customerLabel: counterRow?.customerLabel ?? customerLabel(
      bidder
        ? { display_name: bidder.display_name ?? null, email: bidder.email ?? null }
        : undefined,
    ),
  };
}

export function counterDetailsToRecord(
  map: Map<string, CounterRowDetailV2>,
): Record<string, CounterRowDetailV2> {
  return Object.fromEntries(map.entries());
}

export { invoiceShortId };
