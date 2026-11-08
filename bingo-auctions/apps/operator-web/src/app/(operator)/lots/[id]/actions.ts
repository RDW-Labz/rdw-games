'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { relistLotInto } from '@/lib/relist';
import {
  dollarsToCents,
  hasAtMostTwoDecimals,
  keepRefusalMessage,
  KEEP_MAX_PRICE_CENTS,
  KEEP_REASON_MAX,
} from '@/lib/keep-for-business';
import {
  footprintReasonsFromLot,
  footprintRefusalMessage,
  lotDeleteErrorMessage,
} from '@/lib/lot-delete';
import { lotActionMessage, STAFF_NAME_MAX, STAFF_REASON_MAX } from '@/lib/lot-staff-action';
import { lotEditPolicy, PRICE_FIELD_LABELS, type PriceField } from './edit/lot-edit-policy';

const relistSchema = z.object({
  lotId: z.string().uuid(),
  targetAuctionId: z.string().uuid(),
});

// Edit fields the operator can change after creation. Bid-state fields
// (current_bid_cents, winner_bidder_id, bid_count, status) are intentionally
// NOT editable — those are owned by the auction engine.
const editLotSchema = z.object({
  lotId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullable(),
  category: z.string().max(60).nullable(),
  condition: z.enum(['appears_new', 'open_box', 'good', 'as_is']),
  msrpCents: z.number().int().nonnegative().nullable(),
  startingBidCents: z.number().int().min(100).max(1_000_000_00),
  flatPriceCents: z.number().int().min(100).max(1_000_000_00).nullable(),
  dutchStartCents: z.number().int().min(100).max(1_000_000_00).nullable(),
  dutchFloorCents: z.number().int().min(100).max(1_000_000_00).nullable(),
  dutchDeclinePerMinuteCents: z.number().int().min(1).max(1_000_000).nullable(),
});

export async function editLot(input: z.infer<typeof editLotSchema>) {
  const parsed = editLotSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();

  // What may change is decided by lotEditPolicy (edit/lot-edit-policy.ts), the
  // same rule the form uses to grey fields out (Braden 2026-10-13): title,
  // description, category and condition always save; prices only while the
  // lot has no bids and is still pre-sale. A locked price that was submitted
  // with a different value is NOT written and is named in `dropped`, so the
  // form never reports a clean save while discarding something.
  //
  // Operator scope verification mirrors the warehouse/floorplan pattern.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated' };
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false as const, error: 'Not an operator' };
  const staffTyped = staff as { operator_id: string; role: string };

  const { data: existing } = await supabase
    .from('lots')
    .select(
      'status, bid_count, operator_id, msrp_cents, starting_bid_cents, flat_price_cents, dutch_start_cents, dutch_floor_cents, dutch_decline_per_minute_cents',
    )
    .eq('id', parsed.data.lotId)
    .single();
  if (!existing) return { ok: false as const, error: 'lot not found' };
  const row = existing as {
    status: string;
    bid_count: number | null;
    operator_id: string;
    msrp_cents: number | null;
    starting_bid_cents: number | null;
    flat_price_cents: number | null;
    dutch_start_cents: number | null;
    dutch_floor_cents: number | null;
    dutch_decline_per_minute_cents: number | null;
  };
  if (row.operator_id !== staffTyped.operator_id) {
    return { ok: false as const, error: 'lot not found' };
  }

  const policy = lotEditPolicy({ status: row.status, bidCount: row.bid_count ?? 0 });

  const update: Record<string, unknown> = {
    title: parsed.data.title,
    description: parsed.data.description,
    category: parsed.data.category,
    condition: parsed.data.condition,
  };

  const priceColumns: Array<[PriceField, string, number | null]> = [
    ['msrpCents', 'msrp_cents', row.msrp_cents],
    ['startingBidCents', 'starting_bid_cents', row.starting_bid_cents],
    ['flatPriceCents', 'flat_price_cents', row.flat_price_cents],
    ['dutchStartCents', 'dutch_start_cents', row.dutch_start_cents],
    ['dutchFloorCents', 'dutch_floor_cents', row.dutch_floor_cents],
    ['dutchDeclinePerMinuteCents', 'dutch_decline_per_minute_cents', row.dutch_decline_per_minute_cents],
  ];
  const dropped: string[] = [];
  for (const [field, column, current] of priceColumns) {
    const submitted = parsed.data[field];
    if (!policy.pricesLocked) {
      update[column] = submitted;
    } else if ((submitted ?? null) !== (current ?? null)) {
      dropped.push(PRICE_FIELD_LABELS[field]);
    }
  }

  // .select('id') so an update that matched no row (RLS, or the lot moved
  // operator) is reported instead of claimed as saved.
  const { data: written, error } = await supabase
    .from('lots')
    .update(update)
    .eq('id', parsed.data.lotId)
    .eq('operator_id', staffTyped.operator_id)
    .select('id');
  if (error) return { ok: false as const, error: error.message };
  if (!written || (written as unknown[]).length === 0) {
    return { ok: false as const, error: 'Nothing was saved — the lot could not be updated. Reload and try again.' };
  }

  revalidatePath(`/lots/${parsed.data.lotId}`);
  revalidatePath('/lots');
  return {
    ok: true as const,
    pricesLocked: policy.pricesLocked,
    lockReason: policy.lockReason,
    dropped,
  };
}

// Hard-delete a single lot. Admin/manager only. Allowed only for lots
// that have no commercial side-effects yet (no bids, not in an active
// auction, not won) AND no physical footprint. Replaces the prior
// soft-delete-to-Trash UI which was removed from Inventory.
//
// Allowed statuses: pending_intake, in_inventory, unsold, relisted, canceled.
// Blocked statuses: scheduled (if has bids), live, won.
//
// Physical footprint (2026-10-06, BIN-028904 deleted from inventory with no
// trace): a lot with a sticker, a shelf or location history is a real item,
// and only Remove from inventory (mig 0319) may take it out. The row-level
// reasons are checked here; mig 0400's BEFORE DELETE trigger checks all six
// sources and writes the operator_audit_log row for every delete it allows,
// and its refusal is mapped to the same staff copy (lib/lot-delete).
//
// The server action re-checks bid_count + status so a stale page can't
// slip through. import_rows.lot_id ON DELETE SET NULL (0029) keeps the
// source manifest row intact and re-scannable.
export async function deleteLot(input: { lot_id: string }) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false as const, error: 'Not an operator' };
  if (staff.role !== 'admin' && staff.role !== 'manager') {
    return { ok: false as const, error: 'Admins or managers only' };
  }

  const { data: lot } = await supabase
    .from('lots')
    .select('id, status, operator_id, auction_id, sticker_code, intake_bin_id, intake_at')
    .eq('id', input.lot_id)
    .single();
  if (!lot) return { ok: false as const, error: 'Lot not found' };
  if (lot.operator_id !== staff.operator_id) {
    return { ok: false as const, error: 'Lot belongs to a different operator' };
  }

  // BUG-ARCH-05 defense: don't trust the denormalized bid_count counter
  // as the authorization gate. Hit the canonical source (the bids table)
  // via a HEAD count. Migration 0101 added a trigger maintaining
  // bid_count from the same source, but checking directly here keeps
  // delete-blocking-on-bids authoritative even if the trigger ever
  // gets accidentally disabled.
  const { count: bidsCount } = await supabase
    .from('bids')
    .select('id', { count: 'exact', head: true })
    .eq('lot_id', input.lot_id);
  if ((bidsCount ?? 0) > 0) {
    return {
      ok: false as const,
      error: 'Cannot delete — this lot has bids. Cancel via the auction or wait for it to close.',
    };
  }
  const DELETABLE = ['pending_intake', 'in_inventory', 'unsold', 'relisted', 'canceled'];
  if (!DELETABLE.includes(lot.status as string)) {
    return {
      ok: false as const,
      error: `Cannot delete from status=${lot.status}.`,
    };
  }

  const footprint = footprintReasonsFromLot(lot);
  if (footprint.length > 0) {
    return { ok: false as const, error: footprintRefusalMessage(footprint) };
  }

  // .select() so an RLS-filtered delete (lots_staff_delete is admin-only)
  // reads as "nothing deleted" instead of a silent success.
  const { data: deleted, error } = await supabase
    .from('lots')
    .delete()
    .eq('id', input.lot_id)
    .select('id');
  if (error) return { ok: false as const, error: lotDeleteErrorMessage(error) };
  if (!deleted || deleted.length === 0) {
    return { ok: false as const, error: 'Lot was not deleted. Only an admin can delete lots.' };
  }

  revalidatePath('/lots');
  revalidatePath('/lotting/inventory');
  revalidatePath('/lotting/drafts');
  if (lot.auction_id) revalidatePath(`/auctions/${lot.auction_id}`);
  return { ok: true as const };
}

// Cancel a lot — only allowed before any bids have been placed. Cancelled
// lots flip status='canceled' which the bidder app excludes from browse.
//
// BUG-LL-03 + BUG-ARCH-05 hardening: explicit operator-scope check +
// canonical bids-table count (don't trust the denormalized bid_count
// counter as the authorization gate).
export async function cancelLot(lotId: string) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated' };
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false as const, error: 'Not an operator' };
  const staffTyped = staff as { operator_id: string; role: string };

  const { data: lot } = await supabase
    .from('lots')
    .select('status, operator_id, auction_id')
    .eq('id', lotId)
    .single();
  if (!lot) return { ok: false as const, error: 'lot not found' };
  if ((lot as { operator_id: string }).operator_id !== staffTyped.operator_id) {
    return { ok: false as const, error: 'lot not found' };
  }
  // BUG-ARCH-05 defense: canonical bids count, not the bid_count counter.
  const { count: bidsCount } = await supabase
    .from('bids')
    .select('id', { count: 'exact', head: true })
    .eq('lot_id', lotId);
  if ((bidsCount ?? 0) > 0)
    return { ok: false as const, error: 'cannot cancel — already has bids' };
  if (!['draft', 'scheduled'].includes(lot.status as string)) {
    return { ok: false as const, error: `cannot cancel from status=${lot.status}` };
  }

  const { error } = await supabase
    .from('lots')
    .update({ status: 'canceled', canceled_at: new Date().toISOString(), canceled_by: user.id } as never)
    .eq('id', lotId)
    .eq('operator_id', staffTyped.operator_id);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath('/lots');
  if ((lot as { auction_id: string | null }).auction_id) {
    revalidatePath(`/auctions/${(lot as { auction_id: string }).auction_id}`);
  }
  return { ok: true as const };
}

// Relist creates a NEW lot row in the target auction with the same item
// metadata, fresh bidding state, and references back to the source via the
// notes field. We don't move the original row because invoice_lots may
// reference it via FK.

export async function relistLot(input: z.infer<typeof relistSchema>) {
  const parsed = relistSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();

  // BUG-ARCH-06 + BUG-LL-04 fixes: scope verification, source-status
  // precondition, and mint a fresh lot_code via next_lot_code RPC.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated' };
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false as const, error: 'Not an operator' };
  const staffTyped = staff as { operator_id: string; role: string };
  if (!['admin', 'manager'].includes(staffTyped.role)) {
    return { ok: false as const, error: 'Admin or manager access required to relist' };
  }

  const { data: src } = await supabase
    .from('lots')
    .select(
      'operator_id, status, title, description, category, condition, msrp_cents, starting_bid_cents, photo_urls, warehouse_id',
    )
    .eq('id', parsed.data.lotId)
    .single();
  if (!src) return { ok: false as const, error: 'lot not found' };
  if ((src as { operator_id: string }).operator_id !== staffTyped.operator_id) {
    return { ok: false as const, error: 'lot not found' };
  }
  // BUG-ARCH-06: only certain source states are valid for relisting.
  // A 'won' lot has an invoice pointing at it — relisting it would
  // break the invoice's lineage. A 'draft' lot doesn't need relisting,
  // just edit it. Allowed: unsold (failed to sell), in_inventory
  // (binned but not yet auctioned), or relisted (chain re-relisting).
  // 0353 widened the RPC to also accept a 'won' lot whose every invoice line
  // is refunded — nobody owns it, so it is stock again. Deciding "fully
  // refunded" needs the invoice lines, which this pre-check does not load, so
  // 'won' is let through to the RPC and the server makes the call. A 'won' lot
  // still owed to a customer comes back as relist_source_wrong_status and is
  // reported by the friendly mapping below.
  const ALLOWED_SOURCE_STATUSES = ['unsold', 'in_inventory', 'relisted', 'won'];
  if (!ALLOWED_SOURCE_STATUSES.includes((src as { status: string }).status)) {
    return {
      ok: false as const,
      error: `Cannot relist a ${(src as { status: string }).status} lot. Only unsold, in-inventory, previously relisted, or fully refunded lots can be re-listed.`,
    };
  }

  const { data: target } = await supabase
    .from('auctions')
    .select('id, ends_at, warehouse_id, status, operator_id')
    .eq('id', parsed.data.targetAuctionId)
    .single();
  if (!target) return { ok: false as const, error: 'auction not found' };
  if ((target as { operator_id: string }).operator_id !== staffTyped.operator_id) {
    return { ok: false as const, error: 'auction not found' };
  }
  if (target.warehouse_id !== src.warehouse_id) {
    return { ok: false as const, error: 'Target auction is at a different warehouse' };
  }
  if (!['draft', 'scheduled'].includes(target.status as string)) {
    return { ok: false as const, error: `Cannot relist into status=${target.status}` };
  }

  // 2026-05-20 migration 0097: delegate to relist_lot_into_auction RPC
  // which handles lot_code mint, lot_number assignment, lineage
  // (relisted_from_lot_id), and the relist_count bump atomically. The RPC
  // call + error translation + new-lot-code lookup now live in the shared
  // relistLotInto helper so the Auction Builder carryover path (B7) reuses
  // the exact same implementation.
  const result = await relistLotInto(
    supabase,
    parsed.data.lotId,
    parsed.data.targetAuctionId,
  );
  if (!result.ok) {
    return { ok: false as const, error: result.error };
  }

  revalidatePath(`/auctions/${target.id}`);
  revalidatePath(`/lots/${parsed.data.lotId}`);
  return {
    ok: true as const,
    newLotId: result.newLotId,
    newLotCode: result.newLotCode,
  };
}

// ── Permanent removal from auction inventory (mig 0319) ────────────────────
//
// The other branch of the relot decision. When a refunded / returned item is
// back on the bench, staff either relot it (relistLot above — the normal
// outcome, and what the relot flow was built for) or judge that this one can't
// be sold again and retire it for good.
//
// A refund does NOT imply removal and nothing here is triggered by one; this
// only ever runs when someone picks an outcome. Mig 0471: the console calls
// dispose_lot_attributed, which needs a typed staff name and a reason and
// writes an audit row; an admin can undo it within 24 hours (undoLotRemoval).
// A scheduled/live lot with bids is refused — withdraw it from the auction
// first (withdrawLotFromAuction), which tells its bidders.
const attributionFields = {
  staffName: z.string().trim().min(1, 'Type your name.').max(STAFF_NAME_MAX, `Name must be ${STAFF_NAME_MAX} characters or fewer.`),
  reason: z.string().trim().min(1, 'Say why.').max(STAFF_REASON_MAX, `Reason must be ${STAFF_REASON_MAX} characters or fewer.`),
};

const removeFromInventorySchema = z.object({
  lotId: z.string().uuid(),
  // 'destroyed' — damaged / trash, physically gone.
  // 'bin_store' — transferred to Been There Bought That, not destroyed.
  kind: z.enum(['destroyed', 'bin_store', 'donated', 'liquidated', 'missing', 'other']),
  ...attributionFields,
});

function revalidateLotEverywhere(lotId: string) {
  revalidatePath(`/lots/${lotId}`);
  revalidatePath('/worklist');
  revalidatePath('/lotting/inventory');
  revalidatePath('/reports/aging');
  revalidatePath('/reports/kept');
}

export async function removeLotFromInventory(
  input: z.infer<typeof removeFromInventorySchema>,
) {
  const parsed = removeFromInventorySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();
  const { data: result, error } = await supabase.rpc('dispose_lot_attributed' as never, {
    p_lot_id: parsed.data.lotId,
    p_kind: parsed.data.kind,
    p_staff_name: parsed.data.staffName,
    p_reason: parsed.data.reason,
  } as never);
  if (error) return { ok: false as const, error: error.message };

  const res = (result ?? {}) as { ok?: boolean; reason?: string };
  if (res.ok === false) return { ok: false as const, error: lotActionMessage(res.reason) };

  revalidateLotEverywhere(parsed.data.lotId);
  return { ok: true as const };
}

// ── Keep for business (mig 0381; typed name + reason since 0471) ───────────
//
// The business keeps an item instead of auctioning it. It leaves inventory
// exactly like a removal, plus one lot_internal_keeps row with the price staff
// entered (0 allowed). Not a sale: no invoice, no charge, and no revenue
// figure counts it. A withdrawn lot can be kept; an admin can undo within 24 h.
const keepForBusinessSchema = z.object({
  lotId: z.string().uuid(),
  priceDollars: z
    .number()
    .finite()
    .min(0, 'Price must be $0 or more.')
    .max(KEEP_MAX_PRICE_CENTS / 100, 'Price is too large.')
    .refine(hasAtMostTwoDecimals, 'Price can have at most 2 decimal places.'),
  staffName: attributionFields.staffName,
  reason: z
    .string()
    .trim()
    .min(1, 'Say why the business is keeping it.')
    .max(KEEP_REASON_MAX, `Reason must be ${KEEP_REASON_MAX} characters or fewer.`),
});

export async function keepLotForBusiness(input: z.infer<typeof keepForBusinessSchema>) {
  const parsed = keepForBusinessSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();
  const { data: result, error } = await supabase.rpc('keep_lot_for_business_attributed' as never, {
    p_lot_id: parsed.data.lotId,
    p_price_cents: dollarsToCents(parsed.data.priceDollars),
    p_staff_name: parsed.data.staffName,
    p_reason: parsed.data.reason,
  } as never);
  if (error) return { ok: false as const, error: error.message };

  const res = (result ?? {}) as { ok?: boolean; reason?: string };
  if (res.ok !== true) {
    // The keep wording where it has one (0381), else the shared 0471 wording.
    const keepWords = keepRefusalMessage(res.reason);
    return { ok: false as const, error: keepWords !== (res.reason ?? '') ? keepWords : lotActionMessage(res.reason) };
  }

  revalidateLotEverywhere(parsed.data.lotId);
  return { ok: true as const };
}

// ── Withdraw from auction / undo (mig 0471) ────────────────────────────────
//
// Owner 2026-10-27: a live or scheduled lot can be pulled from its auction
// even with bids (admin/manager, typed name + reason). Its bidders are told by
// push / in-app only. Refused when won, sold or invoiced. Bid history stays.
// Undo puts it back (same auction, number, close time, price, leader) until
// the auction closes.
const lotStaffActionSchema = z.object({ lotId: z.string().uuid(), ...attributionFields });

async function runLotStaffRpc(fn: string, input: z.infer<typeof lotStaffActionSchema>) {
  const parsed = lotStaffActionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }
  const supabase = await getSupabaseServer();
  const { data: result, error } = await supabase.rpc(fn as never, {
    p_lot_id: parsed.data.lotId,
    p_staff_name: parsed.data.staffName,
    p_reason: parsed.data.reason,
  } as never);
  if (error) return { ok: false as const, error: error.message };
  const res = (result ?? {}) as { ok?: boolean; reason?: string; bidders_notified?: number; status?: string };
  if (res.ok !== true) return { ok: false as const, error: lotActionMessage(res.reason) };
  revalidateLotEverywhere(parsed.data.lotId);
  return { ok: true as const, biddersNotified: res.bidders_notified ?? 0, status: res.status ?? null };
}

export async function withdrawLotFromAuction(input: z.infer<typeof lotStaffActionSchema>) {
  return runLotStaffRpc('withdraw_lot_from_auction', input);
}

export async function undoLotWithdrawal(input: z.infer<typeof lotStaffActionSchema>) {
  return runLotStaffRpc('undo_lot_withdrawal', input);
}

/** Admin only, within 24 h of a Dispose / Business use. */
export async function undoLotRemoval(input: z.infer<typeof lotStaffActionSchema>) {
  return runLotStaffRpc('undo_lot_removal', input);
}
