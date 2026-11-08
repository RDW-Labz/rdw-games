'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

// User-requested: pricing 60 manifest items currently requires 60
// individual edits. Bulk operations addressed here:
//   1. assignLotsToAuction — multi-select lots → assign to one auction
//   2. updateLotsStartingBid — set the same starting_bid_cents on many lots

const assignSchema = z.object({
  lotIds: z.array(z.string().uuid()).min(1).max(500),
  auctionId: z.string().uuid(),
});

type AssignResult =
  | { ok: true; assigned: number; skipped: number; skipReasons: Record<string, number> }
  | { ok: false; error: string };

// Assign N in_inventory lots to one auction. Atomic per-lot — uses the
// migration 0099 reserve_lot_number_range RPC to claim a contiguous
// lot_number range under an advisory lock, then UPDATEs each lot with
// its position. Failures are surfaced per-reason so the operator can
// see "47 assigned, 3 skipped because not in_inventory."
export async function assignLotsToAuction(
  input: z.infer<typeof assignSchema>,
): Promise<AssignResult> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  const staffTyped = staff as { operator_id: string; role: string };
  if (!['admin', 'manager'].includes(staffTyped.role)) {
    return { ok: false, error: 'Admin or manager role required for bulk assign' };
  }

  // Resolve the target auction with full ownership + status validation.
  const { data: auction } = await supabase
    .from('auctions')
    .select('id, status, operator_id, warehouse_id, ends_at, last_lot_ends_at')
    .eq('id', parsed.data.auctionId)
    .single();
  if (!auction) return { ok: false, error: 'Auction not found' };
  const auctionTyped = auction as {
    id: string;
    status: string;
    operator_id: string;
    warehouse_id: string;
    ends_at: string;
    last_lot_ends_at: string | null;
  };
  if (auctionTyped.operator_id !== staffTyped.operator_id) {
    return { ok: false, error: 'Auction not found' };
  }
  if (!['draft', 'scheduled'].includes(auctionTyped.status)) {
    return { ok: false, error: `Cannot assign to a ${auctionTyped.status} auction` };
  }

  // Resolve all candidate lots, validate operator scope + status +
  // warehouse match in a single query. Anything that doesn't match the
  // criteria gets bucketed into skipReasons so the caller can show a
  // clear summary.
  const { data: lots } = await supabase
    .from('lots')
    .select('id, status, operator_id, warehouse_id, auction_id')
    .in('id', parsed.data.lotIds);
  const lotsTyped =
    ((lots ?? []) as Array<{
      id: string;
      status: string;
      operator_id: string;
      warehouse_id: string | null;
      auction_id: string | null;
    }>) ?? [];

  const eligibleIds: string[] = [];
  const skipReasons: Record<string, number> = {};
  for (const lotId of parsed.data.lotIds) {
    const lot = lotsTyped.find((l) => l.id === lotId);
    if (!lot) {
      skipReasons.not_found = (skipReasons.not_found ?? 0) + 1;
      continue;
    }
    if (lot.operator_id !== staffTyped.operator_id) {
      skipReasons.cross_operator = (skipReasons.cross_operator ?? 0) + 1;
      continue;
    }
    if (lot.status !== 'in_inventory') {
      skipReasons[`status_${lot.status}`] = (skipReasons[`status_${lot.status}`] ?? 0) + 1;
      continue;
    }
    if (lot.auction_id !== null) {
      skipReasons.already_in_auction = (skipReasons.already_in_auction ?? 0) + 1;
      continue;
    }
    if (lot.warehouse_id !== auctionTyped.warehouse_id) {
      skipReasons.different_warehouse =
        (skipReasons.different_warehouse ?? 0) + 1;
      continue;
    }
    eligibleIds.push(lot.id);
  }

  if (eligibleIds.length === 0) {
    return { ok: true, assigned: 0, skipped: parsed.data.lotIds.length, skipReasons };
  }

  // Reserve a contiguous lot_number range under the per-auction advisory
  // lock (migration 0099). Returns the FIRST number; bulk_assign_lot_numbers
  // (migration 0135) uses it to assign sequential numbers via unnest+ordinality
  // in a single UPDATE rather than N round-trips.
  const { data: firstLotNumber, error: reserveErr } = await supabase.rpc(
    'reserve_lot_number_range',
    { p_auction_id: auctionTyped.id, p_count: eligibleIds.length },
  );
  if (reserveErr || firstLotNumber == null) {
    return {
      ok: false,
      error: reserveErr?.message ?? 'Could not reserve lot numbers',
    };
  }

  // Single-round-trip bulk update: assigns auction_id, lot_number (sequential
  // from firstLotNumber), status, and close_at in one SQL UPDATE via
  // unnest+ordinality. Returns the count of rows actually updated; any gap
  // vs eligibleIds.length is surfaced as update_failed.
  const lotStatus = auctionTyped.status === 'scheduled' ? 'scheduled' : 'draft';
  const { data: updatedCount, error: bulkErr } = await supabase.rpc(
    'bulk_assign_lot_numbers',
    {
      p_lot_ids: eligibleIds,
      p_auction_id: auctionTyped.id,
      p_first_number: firstLotNumber as number,
      p_status: lotStatus,
      p_close_at: auctionTyped.ends_at,
      p_operator_id: staffTyped.operator_id,
    },
  );
  if (bulkErr) {
    return { ok: false, error: bulkErr.message };
  }
  const assigned = (updatedCount as number) ?? 0;
  const failedCount = eligibleIds.length - assigned;
  if (failedCount > 0) {
    skipReasons.update_failed = failedCount;
  }

  // If the auction is windowed-close, redistribute so the assigned
  // batch gets close times spread across the window.
  if (auctionTyped.last_lot_ends_at && assigned > 0) {
    try {
      await supabase.rpc('redistribute_close_times', { p_auction_id: auctionTyped.id });
    } catch {
      // Non-fatal — operator can click Redistribute on the auction page.
    }
  }

  revalidatePath('/lotting/inventory');
  revalidatePath('/lotting');
  revalidatePath(`/auctions/${auctionTyped.id}`);

  return {
    ok: true,
    assigned,
    skipped: parsed.data.lotIds.length - assigned,
    skipReasons,
  };
}

const updatePricingSchema = z.object({
  lotIds: z.array(z.string().uuid()).min(1).max(500),
  startingBidCents: z.number().int().min(100).max(1_000_000_00),
});

// Bulk-set the same starting_bid_cents across many in-inventory lots.
// Useful for the 60-pallet workflow where everything starts at $1.
// Refuses to touch lots that have bids (defense-in-depth) or that are
// past in_inventory (auction lifecycle owns those values).
export async function updateLotsStartingBid(
  input: z.infer<typeof updatePricingSchema>,
): Promise<{ ok: true; updated: number; skipped: number } | { ok: false; error: string }> {
  const parsed = updatePricingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  const staffTyped = staff as { operator_id: string; role: string };
  if (!['admin', 'manager'].includes(staffTyped.role)) {
    return { ok: false, error: 'Admin or manager role required for bulk pricing' };
  }

  // Only update lots that are still in inventory (status='in_inventory'
  // OR 'pending_intake') and have no bids. Bid_count is maintained by
  // migration 0101's trigger; we double-check via the bids table for
  // defense-in-depth (BUG-ARCH-05).
  const { count: result, error } = await supabase
    .from('lots')
    .update({ starting_bid_cents: parsed.data.startingBidCents } as never, {
      count: 'exact',
    })
    .in('id', parsed.data.lotIds)
    .eq('operator_id', staffTyped.operator_id)
    .in('status', ['pending_intake', 'in_inventory'])
    .eq('bid_count', 0);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/lotting/inventory');
  return {
    ok: true,
    updated: result ?? 0,
    skipped: parsed.data.lotIds.length - (result ?? 0),
  };
}
