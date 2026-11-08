'use server';

// completeSession — finalize every PAID pickup in a pickup session at once
// (mig 0241 Phase 1). Reuses markPickup per pickup so the paid-guard and
// lot-routing invariants live in exactly one place; a partial failure
// reports which invoices completed and which didn't.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { loadSessionContents } from '@/lib/pickup-session';
import { markPickup } from '../../actions';
import { MISSING_NOTE_MAX } from './missing-confirm';

export type CompleteSessionResult = {
  ok: boolean;
  completed: number;
  skippedUnpaid: number;
  /** Invoices left OPEN because a lot was marked left-behind (return trip). */
  leftOpen: number;
  errors: string[];
};

export async function completeSession(token: string): Promise<CompleteSessionResult> {
  // Staff gate — same shape as the rest of the operator console actions.
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, completed: 0, skippedUnpaid: 0, leftOpen: 0, errors: ['Not signed in'] };
  const { data: me } = await supabase
    .from('operator_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!me) return { ok: false, completed: 0, skippedUnpaid: 0, leftOpen: 0, errors: ['Not operator staff'] };

  const admin = getSupabaseAdmin();
  const { data: sessionRow } = await admin
    .from('pickup_sessions')
    .select('id, bidder_id, status')
    .eq('token', token)
    .maybeSingle();
  const session = sessionRow as { id: string; bidder_id: string; status: string } | null;
  if (!session) return { ok: false, completed: 0, skippedUnpaid: 0, leftOpen: 0, errors: ['Session not found'] };
  if (session.status !== 'open') {
    return { ok: false, completed: 0, skippedUnpaid: 0, leftOpen: 0, errors: [`Session already ${session.status}`] };
  }

  const { invoices, items } = await loadSessionContents(session.bidder_id);
  const payable = invoices.filter(
    (i) => i.status === 'paid' || i.status === 'partially_refunded',
  );
  const skippedUnpaid = invoices.length - payable.length;

  // Partial checkout (mig 0243): an invoice with any 'left_behind' lot
  // stays OPEN — the customer is coming back for it. Undecided lots count
  // as collected; 'missing' lots don't block completion (they live on as
  // refund work items on the pickups dashboard).
  const leftBehindPickups = new Set(
    items.filter((i) => i.outcome === 'left_behind').map((i) => i.pickupId),
  );

  let completed = 0;
  let leftOpen = 0;
  const errors: string[] = [];
  for (const inv of payable) {
    if (leftBehindPickups.has(inv.pickupId)) {
      leftOpen++;
      continue;
    }
    const res = await markPickup({ pickupId: inv.pickupId, status: 'completed' });
    if (res.ok) completed++;
    else errors.push(`${inv.id.slice(0, 8)}: ${res.error}`);
  }

  // Close the session only when nothing pickup-able remains — unpaid
  // invoices and left-behind lots keep it open for the next visit.
  if (errors.length === 0 && skippedUnpaid === 0 && leftOpen === 0) {
    await admin
      .from('pickup_sessions')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        completed_by: user.id,
      })
      .eq('id', session.id)
      .eq('status', 'open');
  }

  revalidatePath(`/pickups/session/${token}`);
  revalidatePath('/pickups');
  return { ok: errors.length === 0, completed, skippedUnpaid, leftOpen, errors };
}

// ── Per-lot outcome (mig 0243) ───────────────────────────────────────────────
// Sets/clears the staff-recorded outcome for one lot of one pickup. Upsert on
// (pickup_id, lot_id); outcome null deletes the row (back to undecided).

export async function setLotOutcome(input: {
  token: string;
  pickupId: string;
  lotId: string;
  outcome: 'collected' | 'missing' | 'left_behind' | null;
  /** #849: optional Missing reason from a quick pick and/or typed note. */
  note?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const parsed = z
    .object({
      token: z.string().min(1),
      pickupId: z.string().uuid(),
      lotId: z.string().uuid(),
      outcome: z.enum(['collected', 'missing', 'left_behind']).nullable(),
      note: z.string().max(MISSING_NOTE_MAX).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input' };
  const data = parsed.data;
  const note = data.note?.trim() ? data.note.trim() : null;
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in' };
  const { data: me } = await supabase
    .from('operator_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!me) return { ok: false, error: 'Not operator staff' };

  const admin = getSupabaseAdmin();
  // The pickup must belong to the scanned session's bidder — prevents a
  // stale tab from writing outcomes onto someone else's pickup.
  const { data: sess } = await admin
    .from('pickup_sessions')
    .select('bidder_id')
    .eq('token', data.token)
    .maybeSingle();
  if (!sess) return { ok: false, error: 'Session not found' };
  const { data: pickupRow } = await admin
    .from('pickups')
    .select('id, invoices!inner(bidder_id)')
    .eq('id', data.pickupId)
    .maybeSingle();
  const ownerOk =
    (pickupRow as unknown as { invoices?: { bidder_id?: string } } | null)?.invoices?.bidder_id ===
    (sess as { bidder_id: string }).bidder_id;
  if (!ownerOk) return { ok: false, error: 'Pickup does not belong to this session' };

  if (data.outcome === null) {
    const { error } = await admin
      .from('pickup_lot_outcomes')
      .delete()
      .eq('pickup_id', data.pickupId)
      .eq('lot_id', data.lotId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await admin.from('pickup_lot_outcomes').upsert(
      {
        pickup_id: data.pickupId,
        lot_id: data.lotId,
        outcome: data.outcome,
        note,
        decided_by: user.id,
        // 0487 (#798): decided_at is deliberately NOT sent. The database
        // trigger owns the decision time: it moves on a real change and keeps
        // the old value on an identical UPSERT, so a stale write can never
        // refresh a decision the completion guard already judged.
      },
      { onConflict: 'pickup_id,lot_id' },
    );
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/pickups/session/${data.token}`);
  return { ok: true };
}
