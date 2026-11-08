/**
 * Batch-load off-site pickup copy for invoice-scoped notifications. Uses
 * warehouses(*) (never names 0406 columns in filters) and degrades to an empty
 * map on any error so drains keep sending today's copy.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_TIME_ZONE, warehouseTimezone } from '@/lib/datetime';
import { buildOffsiteNotificationCopy, type OffsiteNotificationCopy } from '@/lib/offsite-notification-copy';
import { describeWarehousePickup, type WarehousePickupSource } from '@/lib/warehouse-pickup';

export const INVOICE_OFFSITE_NOTIFICATION_KINDS = new Set<string>([
  'won',
  'payment_succeeded',
  'pickup_ready',
  'pickup_reminder',
]);

function normalizeOne<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function invoiceIdsForOffsiteLoad(
  rows: Array<{ kind: string; payload: Record<string, unknown> }>,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!INVOICE_OFFSITE_NOTIFICATION_KINDS.has(row.kind)) continue;
    const id = row.payload['invoice_id'];
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return Array.from(ids);
}

export async function loadOffsiteNotificationCopyByInvoiceId(
  supabase: SupabaseClient,
  invoiceIds: string[],
): Promise<Map<string, OffsiteNotificationCopy>> {
  const out = new Map<string, OffsiteNotificationCopy>();
  if (invoiceIds.length === 0) return out;

  const { data, error } = await supabase
    .from('invoices')
    .select('id, auctions(pickup_starts_at, pickup_ends_at, warehouses(*))')
    .in('id', invoiceIds);

  if (error || !data) return out;

  for (const row of data as Array<{
    id: string;
    auctions: {
      pickup_starts_at: string | null;
      pickup_ends_at: string | null;
      warehouses: unknown;
    } | Array<{
      pickup_starts_at: string | null;
      pickup_ends_at: string | null;
      warehouses: unknown;
    }> | null;
  }>) {
    const auction = normalizeOne(row.auctions);
    if (!auction) continue;
    const warehouse = normalizeOne(auction.warehouses) as WarehousePickupSource | null;
    const described = describeWarehousePickup(warehouse);
    const tz = warehouseTimezone(warehouse) ?? DEFAULT_TIME_ZONE;
    const copy = buildOffsiteNotificationCopy(
      described,
      auction.pickup_starts_at,
      auction.pickup_ends_at,
      tz,
    );
    if (copy) out.set(row.id, copy);
  }

  return out;
}

export function offsiteCopyForRow(
  row: { kind: string; payload: Record<string, unknown> },
  byInvoiceId: Map<string, OffsiteNotificationCopy>,
): OffsiteNotificationCopy | null {
  if (!INVOICE_OFFSITE_NOTIFICATION_KINDS.has(row.kind)) return null;
  const invoiceId = row.payload['invoice_id'];
  if (typeof invoiceId !== 'string') return null;
  return byInvoiceId.get(invoiceId) ?? null;
}
