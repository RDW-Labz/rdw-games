'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

// ── S12: customer-search server action ────────────────────────────────────────
// Wraps the staff_search_bidder_invoices RPC so the client component can
// call it without needing a Supabase client on the browser.

export type CustomerSearchRow = {
  invoice_id: string;
  bidder_id: string;
  display_name: string | null;
  email: string;
  status: string;
  total_cents: number;
  created_at: string;
};

export async function searchCustomers(query: string): Promise<{
  ok: true;
  results: CustomerSearchRow[];
} | {
  ok: false;
  error: string;
}> {
  if (!query || query.trim().length < 2) {
    return { ok: true, results: [] };
  }
  const supabase = await getSupabaseServer();
  const { data, error } = await supabase.rpc('staff_search_bidder_invoices', {
    p_query: query.trim(),
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, results: (data as CustomerSearchRow[]) ?? [] };
}

const markSchema = z.object({
  pickupId: z.string().uuid(),
  status: z.enum(['completed', 'no_show', 'forfeited']),
});

export async function markPickup(input: z.infer<typeof markSchema>) {
  const parsed = markSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const supabase = await getSupabaseServer();

  // Load the pickup up front — we need its invoice both for the paid-guard
  // on completion and for lot routing on no_show/forfeited.
  const { data: pickup, error: pickupErr } = await supabase
    .from('pickups')
    .select('id, invoice_id')
    .eq('id', parsed.data.pickupId)
    .single();
  if (pickupErr || !pickup) return { ok: false as const, error: pickupErr?.message ?? 'pickup not found' };

  // ── Money-loss guard: never release goods against an unpaid invoice. ────
  // Mirrors the staff_confirm_pickup RPC invariant (mig 0147:236) that the
  // field-mobile app enforces — the web path must not be a softer route to
  // completion. In offline-cash mode staff clear this via the invoice's
  // "Mark paid (offline)" action first. (The RPC accepts only 'paid'; we
  // also allow 'partially_refunded' — a paid invoice with a partial refund
  // is still collectable. Align the RPC if you want strict parity.)
  //
  // 0245: a FULLY refunded invoice may also be completed — that's not a
  // goods release, it's bookkeeping: nothing is owed (every lot refunded /
  // handed over), the pickup is done. The refund-items API auto-completes
  // these; this branch covers pickups stranded before that existed.
  if (parsed.data.status === 'completed') {
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('status')
      .eq('id', pickup.invoice_id)
      .single();
    if (invErr || !invoice) return { ok: false as const, error: invErr?.message ?? 'invoice not found' };
    const paid = invoice.status === 'paid' || invoice.status === 'partially_refunded';
    if (!paid && invoice.status === 'refunded') {
      const { count: owed } = await supabase
        .from('invoice_lots')
        .select('lot_id', { count: 'exact', head: true })
        .eq('invoice_id', pickup.invoice_id)
        .is('picked_up_at', null)
        .is('refunded_at', null);
      if ((owed ?? 0) > 0) {
        return {
          ok: false as const,
          error: 'Invoice refunded but some lots are unresolved — refund or hand over each lot first.',
        };
      }
    } else if (!paid) {
      return {
        ok: false as const,
        error: 'Invoice not paid — collect payment or use Mark paid (offline) first.',
      };
    }
  }

  const update: Record<string, unknown> = { status: parsed.data.status };
  if (parsed.data.status === 'completed') update['completed_at'] = new Date().toISOString();

  // Read the persisted status back: 0487's completion guard can keep a pickup
  // 'checked_in' when a line undone from this visit is still owed. That is a
  // BEFORE trigger, so the UPDATE succeeds — without this check the console
  // and the session page would both report a completion that never happened.
  const { data: updated, error: updateErr } = await supabase
    .from('pickups')
    .update(update)
    .eq('id', parsed.data.pickupId)
    .select('status')
    .maybeSingle();
  if (updateErr) return { ok: false as const, error: updateErr.message };
  const persisted = (updated as { status?: string } | null)?.status;
  if (persisted !== parsed.data.status) {
    return {
      ok: false as const,
      error:
        parsed.data.status === 'completed'
          ? 'Pickup kept checked in: an item undone from this visit is still owed. Mark it collected (a later handover) before completing the visit.'
          : `Pickup did not change to ${parsed.data.status}.`,
    };
  }

  // On no_show or forfeited, route the invoice's still-owed lots back into
  // the auto-relist pool. The auto_relist_unsold_lots cron (mig 0097/0146)
  // picks up lots with status='unsold', so that's the value we set.
  // 'forfeited' pickups behave identically to 'no_show' for lot routing —
  // the bidder loses the win and the lots are relisted. The distinction
  // is captured in the pickup.status column for auditing/policy purposes.
  //
  // 0245: only route lots the bidder still owes. Lots already handed over
  // (picked_up_at), refunded (refunded_at), or confirmed missing from the
  // shelf (pickup_lot_outcomes) must NOT be relisted — a refunded or
  // missing item either doesn't exist or isn't BinGo's to sell twice.
  if (parsed.data.status === 'no_show' || parsed.data.status === 'forfeited') {
    const { data: lots } = await supabase
      .from('invoice_lots')
      .select('lot_id')
      .eq('invoice_id', pickup.invoice_id)
      .is('picked_up_at', null)
      .is('refunded_at', null);
    let lotIds = (lots ?? []).map((l) => l.lot_id as string);
    if (lotIds.length) {
      const { data: missingRows } = await supabase
        .from('pickup_lot_outcomes')
        .select('lot_id')
        .eq('pickup_id', parsed.data.pickupId)
        .eq('outcome', 'missing');
      const missing = new Set(((missingRows ?? []) as { lot_id: string }[]).map((r) => r.lot_id));
      lotIds = lotIds.filter((id) => !missing.has(id));
    }
    // 0351/0356: the customer's own pickup-pass tick is the counter's other
    // record of a hand-off. The sweep honours it; this button must too, or a
    // console forfeit becomes the one path that reclaims a box the customer
    // says they carried out. Left 'won', the lot stays visible to the audit
    // instead of silently joining the relist pool.
    if (lotIds.length) {
      const { data: tickedRows } = await supabase
        .from('pickup_sessions')
        .select('collected_lot_ids')
        .overlaps('collected_lot_ids', lotIds);
      const ticked = new Set(
        ((tickedRows ?? []) as { collected_lot_ids: string[] | null }[]).flatMap((r) => r.collected_lot_ids ?? []),
      );
      lotIds = lotIds.filter((id) => !ticked.has(id));
    }
    if (lotIds.length) {
      await supabase.from('lots').update({ status: 'unsold' }).in('id', lotIds);
    }
  }

  revalidatePath('/pickups');
  revalidatePath('/lots');
  return { ok: true as const };
}

// ── Pickup sessions rollout toggle (mig 0241) ────────────────────────────────
// Admin/manager-only switch for platform_settings.pickup_sessions_enabled.
// While OFF the bidder Pickup pass page + progress API refuse; the staff
// session page keeps working so an already-issued QR always scans.

export async function setPickupSessionsEnabled(enabled: boolean) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not signed in' };
  const { data: me } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  const role = (me as { role?: string } | null)?.role;
  if (!role || !['admin', 'manager'].includes(role)) {
    return { ok: false as const, error: 'Insufficient permissions' };
  }

  const { getSupabaseAdmin } = await import('@/lib/supabase-admin');
  const { error } = await getSupabaseAdmin()
    .from('platform_settings')
    .update({ pickup_sessions_enabled: enabled })
    .eq('id', true);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath('/pickups');
  return { ok: true as const };
}


// ── Missing-item queue (mig 0243) ────────────────────────────────────────────
// Marks a missing-item work row resolved once staff processed the refund
// (the refund itself is a human action on the invoice page — by design).

export async function resolveMissingItem(outcomeId: string) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not signed in' };
  const { data: me } = await supabase
    .from('operator_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!me) return { ok: false as const, error: 'Not operator staff' };

  const { getSupabaseAdmin } = await import('@/lib/supabase-admin');
  const admin = getSupabaseAdmin();
  const resolvedAt = new Date().toISOString();
  const { data: resolved, error } = await admin
    .from('pickup_lot_outcomes')
    .update({ resolved_at: resolvedAt })
    .eq('id', outcomeId)
    .eq('outcome', 'missing')
    .is('resolved_at', null)
    .select('lot_id, pickup_id')
    .maybeSingle();
  if (error) return { ok: false as const, error: error.message };

  // Resolving means "the refund has been processed", so the line is no longer
  // owed — stamp it. Without this, marking the queue row resolved changed
  // nothing the counter can see: pickup-verify hides a line on
  // invoice_lots.refunded_at, and only the refund-ITEMS route ever writes that.
  // Refund an amount from the invoice page instead (the common path for a
  // missing item) and the line stays owed forever, so the item keeps coming
  // back as available for pickup. Reported 2026-08-27 with a photo of
  // "Breakroom Table PNK4996413 — MISSING · refund queued" still listed on a
  // visit whose queue row had been resolved on 2026-07-08. Eight lines were in
  // that state.
  const row = resolved as { lot_id: string; pickup_id: string } | null;
  if (row) {
    const { data: pk } = await admin
      .from('pickups')
      .select('invoice_id')
      .eq('id', row.pickup_id)
      .maybeSingle();
    const invoiceId = (pk as { invoice_id?: string } | null)?.invoice_id;
    if (invoiceId) {
      const { error: stampErr } = await admin
        .from('invoice_lots')
        .update({ refunded_at: resolvedAt })
        .eq('invoice_id', invoiceId)
        .eq('lot_id', row.lot_id)
        .is('refunded_at', null);
      // Never fail the resolve over the stamp — the queue row is already
      // resolved — but make the gap loud rather than silent.
      if (stampErr) {
        console.error('[pickups] resolved missing item but refunded_at stamp failed', {
          outcome_id: outcomeId,
          lot_id: row.lot_id,
          error: stampErr.message,
        });
      }
    }
  }

  revalidatePath('/pickups');
  return { ok: true as const };
}
