// Off-site warehouse notice gate: must the bidder acknowledge customer_notice
// before bidding on a lot at that warehouse? Client-only; place_bid unchanged.
// Fail open on any lookup/RPC error (missing mig 0407/0410, offline).

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  describeWarehousePickup,
  type WarehousePickupDescribed,
  type WarehousePickupSource,
} from '@/lib/warehouse-pickup';

export type OffsiteNoticeGate = 'no_notice' | 'acked' | 'needs_ack' | 'lookup_failed';

export type OffsiteNoticeGateLookup = {
  gate: OffsiteNoticeGate;
  pickup: WarehousePickupDescribed | null;
  warehouseId: string | null;
};

export function decideOffsiteNoticeGate(input: {
  pickup: WarehousePickupDescribed | null;
  pickupLookupFailed: boolean;
  /** null when has_acked RPC errored or is missing. */
  hasAcked: boolean | null;
}): OffsiteNoticeGate {
  if (input.pickupLookupFailed) return 'lookup_failed';
  if (!input.pickup?.isOffsite) return 'no_notice';
  if (input.hasAcked === null) return 'lookup_failed';
  return input.hasAcked ? 'acked' : 'needs_ack';
}

async function fetchPickupRow(
  supabase: SupabaseClient,
  warehouseId: string,
): Promise<{ row: WarehousePickupSource | null; failed: boolean }> {
  try {
    const { data, error } = await supabase.rpc('public_warehouse_pickup_info', {
      p_warehouse_id: warehouseId,
    });
    if (error) return { row: null, failed: true };
    const raw = Array.isArray(data) ? data[0] : data;
    if (!raw || typeof raw !== 'object') return { row: null, failed: false };
    return { row: raw as WarehousePickupSource, failed: false };
  } catch {
    return { row: null, failed: true };
  }
}

async function fetchHasAcked(
  supabase: SupabaseClient,
  warehouseId: string,
): Promise<boolean | null> {
  try {
    const { data, error } = await supabase.rpc('has_acked_warehouse_notice', {
      p_warehouse_id: warehouseId,
    });
    if (error) return null;
    return data === true;
  } catch {
    return null;
  }
}

export async function lookupOffsiteNoticeGateForLot(
  supabase: SupabaseClient,
  lotId: string,
  cache?: Map<string, Promise<OffsiteNoticeGateLookup>>,
): Promise<OffsiteNoticeGateLookup> {
  let warehouseId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('lots')
      .select('warehouse_id')
      .eq('id', lotId)
      .maybeSingle();
    if (error) {
      return { gate: 'lookup_failed', pickup: null, warehouseId: null };
    }
    warehouseId = (data as { warehouse_id?: string | null } | null)?.warehouse_id ?? null;
  } catch {
    return { gate: 'lookup_failed', pickup: null, warehouseId: null };
  }

  if (!warehouseId) {
    return { gate: 'no_notice', pickup: null, warehouseId: null };
  }

  const cached = cache?.get(warehouseId);
  if (cached) return cached;

  const pending = (async (): Promise<OffsiteNoticeGateLookup> => {
    const { row, failed: pickupFailed } = await fetchPickupRow(supabase, warehouseId!);
    const pickup = describeWarehousePickup(row);
    const hasAcked = pickup.isOffsite ? await fetchHasAcked(supabase, warehouseId!) : false;
    const gate = decideOffsiteNoticeGate({
      pickup,
      pickupLookupFailed: pickupFailed,
      hasAcked: pickup.isOffsite ? hasAcked : false,
    });
    const result: OffsiteNoticeGateLookup = { gate, pickup, warehouseId };
    if (gate === 'lookup_failed' && cache) {
      cache.delete(warehouseId!);
    }
    return result;
  })();

  cache?.set(warehouseId, pending);
  return pending;
}

export function markOffsiteNoticeAckedInCache(
  cache: Map<string, Promise<OffsiteNoticeGateLookup>> | undefined,
  warehouseId: string | null | undefined,
): void {
  if (!cache || !warehouseId) return;
  cache.set(
    warehouseId,
    Promise.resolve({ gate: 'acked', pickup: null, warehouseId }),
  );
}
