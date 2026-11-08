'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';
import { lotInputSchema, type LotInput } from '@auction-platform/shared/schemas';

export type CreateLotResult =
  | { ok: true; lotId: string; operatorId: string }
  | { ok: false; error: string };

export async function createLot(input: LotInput): Promise<CreateLotResult> {
  const parsed = lotInputSchema.safeParse(input);
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
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  const operatorId = (staff as { operator_id: string }).operator_id;

  // BUG-AC-07 defense-in-depth: only allow inserts into draft/scheduled
  // auctions, AND only into auctions owned by the caller. Without this,
  // an operator could append a draft lot to a closed/live auction via
  // a direct server-action call and corrupt the auction's lot set.
  // Also catches the case where the form's auction dropdown is stale.
  const { data: targetAuction } = await supabase
    .from('auctions')
    .select('id, status, operator_id, warehouse_id, ends_at, last_lot_ends_at')
    .eq('id', parsed.data.auctionId)
    .single();
  if (!targetAuction) return { ok: false, error: 'Auction not found' };
  const tgt = targetAuction as {
    id: string;
    status: string;
    operator_id: string;
    warehouse_id: string;
    ends_at: string;
    last_lot_ends_at: string | null;
  };
  if (tgt.operator_id !== operatorId) {
    return { ok: false, error: 'Auction not found' };
  }
  if (!['draft', 'scheduled'].includes(tgt.status)) {
    return {
      ok: false,
      error: `Cannot add lots to a ${tgt.status} auction. Lots can only be added while the auction is in draft or scheduled.`,
    };
  }
  // Refuse cross-warehouse mismatches early. The DB has no FK linking
  // lots.warehouse_id to auctions.warehouse_id today (see BUG-ARCH-11
  // in docs/auction-lot-audit-plan.md), so we enforce it app-side.
  if (parsed.data.warehouseId !== tgt.warehouse_id) {
    return {
      ok: false,
      error: 'Lot warehouse must match the auction warehouse.',
    };
  }

  // BUG-LL-02 fix (migration 0099): atomic lot_number reservation under
  // a per-auction advisory lock. Concurrent createLot calls on the same
  // auction now serialize cleanly instead of colliding on the same
  // computed MAX+1.
  const { data: reserved, error: rpcErr } = await supabase.rpc(
    'reserve_next_lot_number',
    { p_auction_id: parsed.data.auctionId },
  );
  if (rpcErr || reserved == null) {
    return { ok: false, error: rpcErr?.message ?? 'Could not reserve lot number' };
  }
  const nextLotNumber = reserved as number;

  // lots.lot_code is NOT NULL (0021) with no default and no trigger, and this
  // insert never set it, so the form has never been able to create a lot
  // ("null value in column lot_code", prod 2026-09-30). Mint one the way
  // Quick Lot and the staff app do: the SECURITY DEFINER RPC, which checks the
  // caller is staff of the operator and bumps operators.next_lot_seq.
  const { data: codeData, error: codeErr } = await supabase.rpc('next_lot_code', {
    p_operator_id: operatorId,
  });
  if (codeErr || !codeData) {
    return { ok: false, error: codeErr?.message ?? 'Could not generate a lot code' };
  }
  const lotCode = codeData as string;

  // BUG-AC-04 fix: never trust the client's closeAt for a manually-added
  // lot. The form previously passed `auction.ends_at` for every lot,
  // meaning a lot added at position 47 would have the same close_at as
  // lot 1 — totally wrong for a staggered/windowed-close auction. Use
  // ends_at as a placeholder here and call redistribute_close_times
  // below to assign the correct value based on the auction's actual
  // schedule semantics.
  const placeholderCloseAt = tgt.ends_at;

  const { data, error } = await supabase
    .from('lots')
    .insert({
      operator_id: operatorId,
      auction_id: parsed.data.auctionId,
      warehouse_id: parsed.data.warehouseId,
      lot_number: nextLotNumber,
      lot_code: lotCode,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      category: parsed.data.category ?? null,
      condition: parsed.data.condition,
      msrp_cents: parsed.data.msrpCents ?? null,
      starting_bid_cents: parsed.data.startingBidCents,
      close_at: placeholderCloseAt,
      photo_urls: parsed.data.photoUrls,
      status: 'draft',
      source: 'manual',
      flat_price_cents: parsed.data.flatPriceCents ?? null,
      dutch_start_cents: parsed.data.dutchStartCents ?? null,
      dutch_floor_cents: parsed.data.dutchFloorCents ?? null,
      dutch_decline_per_minute_cents: parsed.data.dutchDeclinePerMinuteCents ?? null,
      // BUG-LL-01 fix: include early-access in the canonical INSERT so it
      // lands atomically. Previously the form patched this after create
      // via a separate client-side UPDATE that could silently fail.
      early_access_until: parsed.data.earlyAccessUntil ?? null,
    } as never)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Insert failed' };

  // BUG-AC-04 fix continued: auto-redistribute close_at across all
  // active lots after adding this one. For windowed-close auctions
  // (last_lot_ends_at set) this evenly distributes across the window.
  // For fixed-stagger legacy auctions, this is a no-op — but in that
  // case the original `closeAt` from the form was equally wrong, so
  // we're no worse off.
  if (tgt.last_lot_ends_at) {
    try {
      await supabase.rpc('redistribute_close_times', { p_auction_id: tgt.id });
    } catch {
      // Non-fatal — operator can still click the "Redistribute close
      // times" button on the auction detail page. Surfaced via UI hint.
    }
  }

  revalidatePath(`/auctions/${parsed.data.auctionId}`);
  revalidatePath('/lots');
  return { ok: true, lotId: data.id as string, operatorId };
}
