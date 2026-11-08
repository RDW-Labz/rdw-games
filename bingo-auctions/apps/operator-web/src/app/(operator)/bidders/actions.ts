'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

// Resolve the caller's operator_id and assert the action target belongs to it.
async function resolveOperator() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  return { supabase, operatorId: (me as { operator_id: string }).operator_id, role: (me as { role: string }).role };
}

export async function suspendBidder(bidderId: string, reason: string) {
  const { supabase, operatorId, role } = await resolveOperator();
  if (role !== 'admin' && role !== 'manager') {
    throw new Error('Insufficient permissions');
  }

  const { error } = await supabase
    .from('operator_bidder_relations')
    .upsert(
      {
        operator_id: operatorId,
        bidder_id: bidderId,
        suspended_at: new Date().toISOString(),
        suspended_reason: reason.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'operator_id,bidder_id' },
    );

  if (error) throw new Error(error.message);
}

export async function unsuspendBidder(bidderId: string) {
  const { supabase, operatorId, role } = await resolveOperator();
  if (role !== 'admin' && role !== 'manager') {
    throw new Error('Insufficient permissions');
  }

  const { error } = await supabase
    .from('operator_bidder_relations')
    .update({
      suspended_at: null,
      suspended_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('operator_id', operatorId)
    .eq('bidder_id', bidderId);

  if (error) throw new Error(error.message);
}

export async function saveNote(bidderId: string, notes: string) {
  const { supabase, operatorId } = await resolveOperator();

  const { error } = await supabase
    .from('operator_bidder_relations')
    .upsert(
      {
        operator_id: operatorId,
        bidder_id: bidderId,
        internal_notes: notes.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'operator_id,bidder_id' },
    );

  if (error) throw new Error(error.message);
}

// ── Resale certificate review (mig 0233) ────────────────────────────────────
// Approve/reject a bidder's submitted resale certificate. Approving sets
// tax_exempt = true, which zeroes tax_cents on invoices built from then on
// (build_invoices_for_auction v3). Service-role write: bidders-table columns
// aren't operator-writable under RLS, and staff identity + role are already
// verified here — same pattern as the cron/route service writes.

export async function setResaleCertStatus(bidderId: string, approve: boolean) {
  const { role } = await resolveOperator();
  if (role !== 'admin' && role !== 'manager') {
    throw new Error('Insufficient permissions');
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('bidders')
    .update({
      resale_cert_status: approve ? 'approved' : 'rejected',
      resale_cert_reviewed_at: new Date().toISOString(),
      tax_exempt: approve,
    })
    .eq('id', bidderId)
    // Only act on a live submission — a stale button click after the bidder
    // resubmitted (or was already reviewed) must not flip state blindly.
    .eq('resale_cert_status', 'pending');

  if (error) throw new Error(error.message);
  revalidatePath(`/bidders/${bidderId}`);
}

// ── Waive outstanding relot fees (owner ask 2026-07-29) ─────────────────────
// A failed auto-charge accrues a flat fee into bidders.unpaid_fees_cents, and
// place_bid refuses while that is > 0 — so the fee IS the bidding block. Until
// now the only way to clear it was /profile/pay-fees, i.e. the bidder paying.
// That is wrong when the charge failed for a reason that is not the bidder's
// fault: the 2026-07-25 case was square.ts parsing a non-JSON upstream 502 body
// as a decline, which blocked a customer whose card worked the night before and
// the morning after.
//
// Admin-only (not manager): this writes off money.
//
// Service-role write for the same reason as setResaleCertStatus — the bidders
// table is not operator-writable under RLS, and staff identity + role are
// already verified above.
export async function waiveBidderFees(bidderId: string, reason: string) {
  const { role } = await resolveOperator();
  if (role !== 'admin') {
    throw new Error('Admin only — waiving fees writes off money.');
  }

  const admin = getSupabaseAdmin();

  const { data: bidder, error: readErr } = await admin
    .from('bidders')
    .select('unpaid_fees_cents')
    .eq('id', bidderId)
    .single();
  if (readErr) throw new Error(readErr.message);

  const outstanding = ((bidder as { unpaid_fees_cents: number | null } | null)?.unpaid_fees_cents) ?? 0;
  if (outstanding <= 0) return { waivedCents: 0 };

  const stamp = new Date().toISOString();
  const note = `waived: ${reason.trim() || 'no reason given'}`.slice(0, 180);

  // Settle the ledger BEFORE zeroing the counter. If the second write fails the
  // bidder stays blocked and this is safely repeatable; the reverse order would
  // unblock them while the ledger still read unpaid.
  const { error: ledgerErr } = await admin
    .from('bidder_fee_ledger')
    .update({ paid_at: stamp, paid_payment_intent_id: note })
    .eq('bidder_id', bidderId)
    .is('paid_at', null);
  if (ledgerErr) throw new Error(ledgerErr.message);

  // Guarded on the amount we read, so a fee accrued between the read and this
  // write is not silently wiped.
  const { error: zeroErr } = await admin
    .from('bidders')
    .update({ unpaid_fees_cents: 0, updated_at: stamp })
    .eq('id', bidderId)
    .eq('unpaid_fees_cents', outstanding);
  if (zeroErr) throw new Error(zeroErr.message);

  revalidatePath(`/bidders/${bidderId}`);
  return { waivedCents: outstanding };
}
