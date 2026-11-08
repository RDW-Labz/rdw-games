// Shared relist helper.
//
// Single canonical client-side wrapper around the relist_lot_into_auction RPC
// (migrations 0097 + 0099). The RPC mints a fresh lot_code + lot_number, sets
// the relisted_from_lot_id lineage, bumps relist_count, and flips the source
// lot's status → 'relisted' atomically under an advisory lock.
//
// Extracted from lots/[id]/actions.ts relistLot so the Auction Builder's
// "carry over unsold / unpicked-up lots" path (B7) and the single-lot relist
// button share one implementation — same RPC, same error translation, same
// new-lot-code lookup. Callers remain responsible for their own auth /
// admin-or-manager gating and revalidatePath() calls.

import type { SupabaseClient } from '@supabase/supabase-js';

export type RelistLotResult =
  | { ok: true; newLotId: string; newLotCode: string }
  | {
      ok: false;
      error: string;
      /** relist_source_already_relisted (mig 0275): an earlier request already
       *  carried this lot over. Not a failure for a batch: the item is listed. */
      alreadyCarried?: boolean;
      /** The lot it now lives on, when the guard named it. */
      alreadyCarriedTo?: string | null;
    };

/**
 * Relist a single lot into a target auction via the relist_lot_into_auction
 * RPC. Translates the RPC's structured error codes to friendly text and
 * resolves the newly-minted lot_code for UI display.
 *
 * Does NOT verify the caller's role or revalidate any paths — the caller owns
 * that. Cross-tenant + warehouse + status preconditions are enforced inside
 * the SECURITY DEFINER RPC itself.
 */
export async function relistLotInto(
  supabase: SupabaseClient,
  lotId: string,
  auctionId: string,
): Promise<RelistLotResult> {
  // 2026-05-20 migration 0097 (locked in 0099): the RPC handles lot_code mint,
  // lot_number assignment, lineage (relisted_from_lot_id), and the relist_count
  // bump atomically. Returns the new lot's UUID (or NULL if the source lot is
  // missing).
  const { data: newLotId, error: rpcErr } = await supabase.rpc('relist_lot_into_auction', {
    p_lot_id: lotId,
    p_auction_id: auctionId,
  });
  if (rpcErr || !newLotId) {
    const message = rpcErr?.message ?? 'relist failed';
    // Translate the RPC error codes to friendlier text.
    // relist_source_already_relisted (mig 0275): the one-item = one-active-lot
    // guard. The source was already carried over onto the lot named in the raw
    // message ("… item already lives on lot BIN-004376"). This is expected when
    // a stale row is clicked; surface it plainly and let the caller refresh.
    const alreadyRelisted = message.includes('relist_source_already_relisted');
    const existingCode = alreadyRelisted
      ? message.match(/lives on lot\s+(\S+)/)?.[1] ?? null
      : null;
    const friendly = alreadyRelisted
      ? `Already carried over${existingCode ? ` — it now lives on lot ${existingCode}` : ''}. Refresh the list; this item should no longer appear.`
      : message.includes('relist_source_wrong_status')
        ? 'Source lot is not in a relistable state.'
        : message.includes('relist_target_different_warehouse')
          ? 'Target auction is at a different warehouse.'
          : message.includes('relist_target_wrong_status')
            ? 'Target auction must be draft or scheduled.'
            : message.includes('relist_target_auction_not_found')
              ? 'Auction not found.'
              : message.includes('relist_cross_tenant')
                ? 'Lot belongs to a different operator.'
                : message;
    return alreadyRelisted
      ? { ok: false, error: friendly, alreadyCarried: true, alreadyCarriedTo: existingCode }
      : { ok: false, error: friendly };
  }

  // Pull the new lot's lot_code for the response so the UI can show
  // "Created CLU-001234" in a toast.
  const { data: newRow } = await supabase
    .from('lots')
    .select('lot_code')
    .eq('id', newLotId as string)
    .single();

  return {
    ok: true,
    newLotId: newLotId as string,
    newLotCode: (newRow as { lot_code: string } | null)?.lot_code ?? '',
  };
}
