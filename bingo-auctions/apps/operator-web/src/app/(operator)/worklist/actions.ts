'use server';

import { lotDisplayCode } from '@auction-platform/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

// Worklist inline row actions (M9 — live-test feedback 2026-06-03). The page
// is read-only triage; these give staff the three actions they reached for
// most often without leaving the list:
//
//   • relistWorklistLot   → delegates to the canonical relist_lot_into_auction
//                            RPC (same one /lots/[id] and auto-relist use).
//   • pullLotToInventory  → flips an unsold/relisted lot back to in_inventory
//                            (status-based, mirrors the guarded-UPDATE pattern
//                            in lotting/inventory/actions.ts — NO new RPC).
//   • disposeWorklistLot  → delegates to the mark_lot_disposed RPC (mig 0146).
//
// All three are admin/manager-gated, operator-scoped, and revalidate
// /worklist (+ the affected lot / auction) so the list reflects the change.

const relistSchema = z.object({
  lotId: z.string().uuid(),
  targetAuctionId: z.string().uuid(),
});

// Relist an unsold/relisted/in_inventory lot into a draft/scheduled auction at
// the same warehouse. Thin wrapper over the relist_lot_into_auction RPC
// (mig 0097) — identical semantics to lots/[id]/actions.ts relistLot, with a
// /worklist revalidate. Returns the freshly-minted lot_code so the UI can show
// "Created {new code} (was {old code})" (L3).
export async function relistWorklistLot(input: z.infer<typeof relistSchema>) {
  const parsed = relistSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

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
  if (!['admin', 'manager'].includes(staffTyped.role)) {
    return { ok: false as const, error: 'Admin or manager access required to relist' };
  }

  // Source + target scope checks mirror lots/[id]/actions.ts relistLot. The
  // RPC re-validates everything under FOR UPDATE; these checks give a friendly
  // early error and keep cross-tenant rows invisible.
  const { data: src } = await supabase
    .from('lots')
    .select('operator_id, status, warehouse_id')
    .eq('id', parsed.data.lotId)
    .single();
  if (!src) return { ok: false as const, error: 'lot not found' };
  if ((src as { operator_id: string }).operator_id !== staffTyped.operator_id) {
    return { ok: false as const, error: 'lot not found' };
  }
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
    .select('id, warehouse_id, status, operator_id')
    .eq('id', parsed.data.targetAuctionId)
    .single();
  if (!target) return { ok: false as const, error: 'auction not found' };
  if ((target as { operator_id: string }).operator_id !== staffTyped.operator_id) {
    return { ok: false as const, error: 'auction not found' };
  }
  if ((target as { warehouse_id: string }).warehouse_id !== (src as { warehouse_id: string | null }).warehouse_id) {
    return { ok: false as const, error: 'Target auction is at a different warehouse' };
  }
  if (!['draft', 'scheduled'].includes((target as { status: string }).status)) {
    return { ok: false as const, error: `Cannot relist into status=${(target as { status: string }).status}` };
  }

  const { data: newLotId, error: rpcErr } = await supabase.rpc('relist_lot_into_auction', {
    p_lot_id: parsed.data.lotId,
    p_auction_id: parsed.data.targetAuctionId,
  });
  if (rpcErr || !newLotId) {
    const message = rpcErr?.message ?? 'relist failed';
    const friendly = message.includes('relist_source_wrong_status')
      ? 'Source lot is not in a relistable state.'
      : message.includes('relist_target_different_warehouse')
        ? 'Target auction is at a different warehouse.'
        : message.includes('relist_target_wrong_status')
          ? 'Target auction must be draft or scheduled.'
          : message.includes('relist_target_auction_not_found')
            ? 'Auction not found.'
            : message;
    return { ok: false as const, error: friendly };
  }

  // Pull the new lot's code for the L3 "Created {code}" confirmation.
  // sticker_code rides along: since 0213 the relist child inherits the box's
  // physical label, and THAT is the code staff should be told about.
  const { data: newRow } = await supabase
    .from('lots')
    .select('lot_code, sticker_code, display_code')
    .eq('id', newLotId as string)
    .single();

  revalidatePath('/worklist');
  revalidatePath(`/auctions/${(target as { id: string }).id}`);
  revalidatePath(`/lots/${parsed.data.lotId}`);
  return {
    ok: true as const,
    newLotId: newLotId as string,
    newLotCode:
      (newRow ? lotDisplayCode(newRow as { lot_code: string; sticker_code: string | null }) : null) ?? '',
  };
}

const pullSchema = z.object({ lotId: z.string().uuid() });

// Pull an unsold / relisted lot back to in_inventory so it leaves the
// worklist and re-enters the normal Auction Builder flow. Status-based only
// (v1) — no per-bidder deadline / membership concept. Mirrors the guarded
// in-place UPDATE pattern in lotting/inventory/actions.ts: operator-scoped,
// admin/manager-only, and constrained to the relistable source statuses so a
// won/live/scheduled lot can never be silently yanked out of an auction.
// Clears auction_id / lot_number / close_at so the lot looks like normal
// inventory (it was already detached when it went unsold).
export async function pullLotToInventory(input: z.infer<typeof pullSchema>) {
  const parsed = pullSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

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
  if (!['admin', 'manager'].includes(staffTyped.role)) {
    return { ok: false as const, error: 'Admin or manager role required' };
  }

  // Defense-in-depth: the .in('status', …) on the UPDATE itself is the real
  // gate (a concurrent flip to won/live simply matches zero rows), but we
  // also block when the lot has bids, matching cancelLot/deleteLot.
  const { count: bidsCount } = await supabase
    .from('bids')
    .select('id', { count: 'exact', head: true })
    .eq('lot_id', parsed.data.lotId);
  if ((bidsCount ?? 0) > 0) {
    return { ok: false as const, error: 'Cannot pull — this lot has bids.' };
  }

  const { count, error } = await supabase
    .from('lots')
    .update(
      {
        status: 'in_inventory',
        auction_id: null,
        lot_number: null,
        close_at: null,
        updated_at: new Date().toISOString(),
      } as never,
      { count: 'exact' },
    )
    .eq('id', parsed.data.lotId)
    .eq('operator_id', staffTyped.operator_id)
    .in('status', ['unsold', 'relisted']);
  if (error) return { ok: false as const, error: error.message };
  if ((count ?? 0) === 0) {
    return {
      ok: false as const,
      error: 'Lot is no longer unsold (it may have been relisted or disposed). Refresh and retry.',
    };
  }

  revalidatePath('/worklist');
  revalidatePath('/lotting/inventory');
  revalidatePath(`/lots/${parsed.data.lotId}`);
  return { ok: true as const };
}

const disposeSchema = z.object({
  lotId: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

// Dispose a lot — delegates to the mark_lot_disposed RPC (mig 0146), which is
// itself admin/manager-only + operator-scoped and idempotent on already-
// disposed lots. We re-check role here for a friendly early error.
export async function disposeWorklistLot(input: z.infer<typeof disposeSchema>) {
  const parsed = disposeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

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
  if (!['admin', 'manager'].includes(staffTyped.role)) {
    return { ok: false as const, error: 'Admin or manager role required to dispose' };
  }

  const { data: result, error } = await supabase.rpc('mark_lot_disposed', {
    p_lot_id: parsed.data.lotId,
    p_reason: parsed.data.reason ?? null,
  });
  if (error) return { ok: false as const, error: error.message };
  const res = (result ?? {}) as { ok?: boolean; reason?: string };
  if (res.ok === false) {
    return {
      ok: false as const,
      error:
        res.reason === 'lot_live_with_bids'
          ? "This lot is in a running auction and already has bids, so it can't be removed now. Remove it after the auction closes."
          : (res.reason ?? 'dispose failed'),
    };
  }

  revalidatePath('/worklist');
  revalidatePath('/lotting/inventory');
  revalidatePath(`/lots/${parsed.data.lotId}`);
  return { ok: true as const };
}
