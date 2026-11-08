'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { operatorCan } from '@/lib/operator-can';
import { relistLotInto } from '@/lib/relist';
import { loadUnfoundMissing } from '@/lib/missing-items';

// B7: the source bucket the lots came from in the builder.
//   available    → status='in_inventory', auction_id NULL. Plain-assignable
//                  via assign_lots_to_auction (the original path).
//   unsold       → status='unsold'. Keeps a non-null auction_id, so
//                  assign_lots_to_auction RAISES for them — they MUST be
//                  carried over via relist_lot_into_auction (mints a new
//                  lot_code + preserves relisted_from_lot_id lineage).
//   unpicked_up  → status IN ('unsold','relisted') + a no-show/forfeited
//                  pickup. Same carryover (relist) path as unsold.
const sourceEnum = z.enum(['available', 'unsold', 'unpicked_up']);

const addLotsSchema = z.object({
  auction_id: z.string().uuid(),
  lot_ids: z.array(z.string().uuid()).min(1).max(500),
  // Defaults to 'available' so existing callers (and any cached client
  // bundle) keep the original plain-assign behavior.
  source: sourceEnum.default('available'),
});

// Per-lot outcome of a carryover (unsold / unpicked_up) batch, so staff can see
// exactly which lots made it in and which still need adding, and why.
export type CarryoverReport = {
  carried: Array<{ lotId: string; code: string; newCode: string }>;
  failed: Array<{ lotId: string; code: string; reason: string }>;
  /** Carried over by an EARLIER request (2026-10-23: a batch whose answer never
   *  reached the browser, then a retry). Listed already; not a failure. */
  already: Array<{ lotId: string; code: string; newCode: string | null }>;
  /** Set when an error about the TARGET auction stopped the batch: the
   *  builder stops sending further chunks with the same reason. */
  stopped?: string | null;
};

export type AddLotsResult =
  | {
      ok: true;
      added: number;
      firstLotNumber: number;
      lastLotNumber: number;
      carryover?: CarryoverReport;
    }
  | { ok: false; error: string; carryover?: CarryoverReport };

// Errors about the TARGET auction fail every remaining lot the same way, so
// stop there instead of repeating them; per-lot errors move on to the next lot.
const TARGET_LEVEL_ERRORS = [
  'Target auction is at a different warehouse.',
  'Target auction must be draft or scheduled.',
  'Auction not found.',
];

export async function addInventoryToAuction(
  input: z.infer<typeof addLotsSchema>,
): Promise<AddLotsResult> {
  const parsed = addLotsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
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
  if (!(await operatorCan(supabase, 'auction.publish'))) {
    return { ok: false, error: 'Admins or managers only' };
  }

  // B7 carryover path: unsold / unpicked-up lots keep a non-null auction_id +
  // status 'unsold'/'relisted', so assign_lots_to_auction RAISES for them.
  // They must be RELISTED — relist_lot_into_auction mints a fresh lot_code +
  // lot_number and records the relisted_from_lot_id lineage (M8 provenance:
  // relisted_from_lot_id NOT NULL = "carried over"). Loop per lot via the
  // shared helper; the SECURITY DEFINER RPC re-checks tenant + warehouse +
  // status for each. A per-lot failure no longer stops the batch: every lot is
  // tried and the result lists what carried over and what did not, and why
  // (Jared 2026-10-15 — a stop part-way left staff guessing what was added).
  if (parsed.data.source === 'unsold' || parsed.data.source === 'unpicked_up') {
    const lotIds = parsed.data.lot_ids;

    // Codes for the report. Chunked: ids travel in the URL.
    const codeById = new Map<string, string>();
    for (let i = 0; i < lotIds.length; i += 100) {
      const { data } = await supabase
        .from('lots')
        .select('id, lot_code, display_code')
        .in('id', lotIds.slice(i, i + 100));
      for (const r of (data ?? []) as Array<{ id: string; lot_code: string | null; display_code: string | null }>) {
        codeById.set(r.id, r.display_code ?? r.lot_code ?? r.id);
      }
    }
    const codeOf = (id: string) => codeById.get(id) ?? id;

    const report: CarryoverReport = { carried: [], failed: [], already: [] };

    // Mig 0345 refuses to relist an item refunded as missing until it has been
    // put away again. Skip those up front (the page already hides them; this
    // covers a stale page) rather than letting the trigger fail mid-batch.
    const unfound = await loadUnfoundMissing(supabase, lotIds);

    let stopReason: string | null = null;
    for (const lotId of lotIds) {
      if (stopReason) {
        report.failed.push({ lotId, code: codeOf(lotId), reason: `Not tried: ${stopReason}` });
        continue;
      }
      const missingAt = unfound.get(lotId);
      if (missingAt) {
        report.failed.push({
          lotId,
          code: codeOf(lotId),
          reason: `Refunded as missing on ${missingAt.slice(0, 10)} and not found since. Find it and put it away, then it can be listed again.`,
        });
        continue;
      }
      const r = await relistLotInto(supabase, lotId, parsed.data.auction_id);
      if (!r.ok && r.alreadyCarried) {
        report.already.push({ lotId, code: codeOf(lotId), newCode: r.alreadyCarriedTo ?? null });
        continue;
      }
      if (!r.ok) {
        // The trigger's own message is already written for staff; drop the code prefix.
        const reason = r.error.replace(/^relist_blocked_item_missing:\s*/, '');
        report.failed.push({ lotId, code: codeOf(lotId), reason });
        if (TARGET_LEVEL_ERRORS.includes(r.error)) stopReason = r.error;
        continue;
      }
      report.carried.push({ lotId, code: codeOf(lotId), newCode: r.newLotCode });
      // 0278: carried-over lots go LIVE with the auction (operator decision
      // 2026-07-17) instead of lingering as draft ghosts past the lot count.
      // Promote the freshly relisted draft to 'scheduled' with a clamped,
      // staggered close_at — the same shape assign_lots_to_auction produces.
      // Best-effort: a failure just leaves the lot draft (recoverable/editable),
      // so it never fails the carryover mid-batch.
      const sched = await supabase.rpc('schedule_relisted_lot', {
        p_lot_id: r.newLotId,
      });
      if (sched.error) {
        console.error('[addInventoryToAuction] schedule_relisted_lot failed', {
          lot_id: r.newLotId,
          error: sched.error.message,
        });
      }
    }

    report.stopped = stopReason;
    if (report.carried.length > 0 || report.already.length > 0) {
      revalidatePath(`/auctions/${parsed.data.auction_id}`);
      revalidatePath(`/auctions/${parsed.data.auction_id}/builder`);
      revalidatePath('/inventory');
      revalidatePath('/lotting/inventory');
    }
    if (report.failed.length === 0 && report.carried.length === 0 && report.already.length > 0) {
      return {
        ok: false,
        error: `Nothing new to add: ${report.already.length} ${report.already.length === 1 ? 'was' : 'were'} already carried over earlier — see the list below.`,
        carryover: report,
      };
    }
    if (report.failed.length > 0) {
      return {
        ok: false,
        error:
          report.carried.length > 0
            ? `Carried over ${report.carried.length} of ${lotIds.length}. ${report.failed.length} not added — see the list below.`
            : `Nothing was carried over. ${report.failed.length} not added — see the list below.`,
        carryover: report,
      };
    }
    // Relisted lots get their lot_number assigned inside the RPC (not returned
    // here as a contiguous range), so we can't report a first/last range like
    // the assign path. Report the count; firstLotNumber/lastLotNumber are 0.
    return {
      ok: true,
      added: report.carried.length,
      firstLotNumber: 0,
      lastLotNumber: 0,
      carryover: report,
    };
  }

  // available path: plain assignment. Single RPC call replaces the N+1 loop.
  // The RPC enforces auction status, lot status (must be in_inventory),
  // warehouse match, and assigns sequential lot numbers + per-lot staggered
  // close_at atomically.
  const { data: assigned, error: rpcErr } = await supabase.rpc(
    'assign_lots_to_auction',
    {
      p_auction_id: parsed.data.auction_id,
      p_lot_ids: parsed.data.lot_ids,
    },
  );
  if (rpcErr) {
    // The RPC raises with a structured error string. Map common cases
    // to a friendly message; anything else logs server-side and shows
    // a generic error.
    const msg = rpcErr.message ?? '';
    let friendly = 'Assignment failed';
    if (msg.includes('auction_not_found')) friendly = 'Auction not found';
    else if (msg.includes('auction_not_editable_status')) friendly = 'Auction is not editable';
    else if (msg.includes('lot_already_in_auction')) friendly = `Lot already in an auction: ${msg}`;
    else if (msg.includes('lot_not_in_inventory')) friendly = `Lot not in inventory: ${msg}`;
    else if (msg.includes('lot_wrong_warehouse')) friendly = `Lot at wrong warehouse: ${msg}`;
    // mig 0288's one-active-lot-per-item guard. This was missing from the map,
    // so the whole batch failed with a bare "Assignment failed" and the
    // operator had no way to tell WHICH lot was rejected or why — the lot
    // codes are in the raise, they just never reached the screen.
    // Note the RPC is a single transaction: one rejected lot aborts the entire
    // selection, so name the blocker and say nothing was added.
    else if (msg.includes('lot_item_already_listed')) {
      const m = /lot_item_already_listed:([^:\s]+):([^:\s]+)/.exec(msg);
      friendly = m
        ? `Nothing was added. ${m[1]} looks like the same physical item as ${m[2]}, which is already in an active auction. If these are two different items, sticker each one and try again — otherwise remove ${m[1]} from the selection.`
        : `Nothing was added — one of the selected lots is already listed in an active auction: ${msg}`;
    } else if (msg.includes('admin_or_manager_required'))
      friendly = 'Admin or manager required';
    console.error('[addInventoryToAuction] rpc failed', { rpcErr });
    return { ok: false, error: friendly };
  }

  const rows = (assigned ?? []) as Array<{
    lot_id: string;
    lot_code: string;
    lot_number: number;
    close_at: string;
  }>;
  if (rows.length === 0) {
    return { ok: false, error: 'No lots assigned' };
  }

  revalidatePath(`/auctions/${parsed.data.auction_id}`);
  revalidatePath(`/auctions/${parsed.data.auction_id}/builder`);
  revalidatePath('/inventory');
  revalidatePath('/lotting/inventory');

  return {
    ok: true,
    added: rows.length,
    firstLotNumber: rows[0]!.lot_number,
    lastLotNumber: rows[rows.length - 1]!.lot_number,
  };
}
