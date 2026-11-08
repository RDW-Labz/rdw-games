'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

type Result = { ok: true } | { ok: false; error: string };

// Mark a paid+labeled invoice as physically shipped (operator handed
// the package to the carrier). Sets shipped_at, which triggers the
// bidder notification and moves the invoice off the queue.
//
// We don't check the carrier — the operator self-attests. EasyPost's
// tracker webhook (post-launch) will overlay the carrier-acknowledged
// timestamp later.
export async function markShipped(invoiceId: string): Promise<Result> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'not_operator_staff' };
  const meTyped = me as { operator_id: string; role: string };
  if (!['admin', 'manager'].includes(meTyped.role)) {
    return { ok: false, error: 'insufficient_role' };
  }

  const admin = getSupabaseAdmin();
  const { data: invoiceRow } = await admin
    .from('invoices')
    .select('id, operator_id, status, fulfillment_method, shipping_label_url, shipped_at')
    .eq('id', invoiceId)
    .single();
  if (!invoiceRow) return { ok: false, error: 'invoice_not_found' };
  const inv = invoiceRow as {
    id: string;
    operator_id: string;
    status: string;
    fulfillment_method: string | null;
    shipping_label_url: string | null;
    shipped_at: string | null;
  };
  if (inv.operator_id !== meTyped.operator_id) {
    return { ok: false, error: 'invoice_other_operator' };
  }
  if (inv.status !== 'paid') return { ok: false, error: 'invoice_not_paid' };
  if (inv.fulfillment_method !== 'ship') return { ok: false, error: 'not_a_ship_invoice' };
  if (!inv.shipping_label_url) return { ok: false, error: 'no_label_yet' };
  if (inv.shipped_at) return { ok: true }; // idempotent — already marked

  const now = new Date().toISOString();
  const { error } = await admin
    .from('invoices')
    .update({ shipped_at: now, updated_at: now } as never)
    .eq('id', inv.id)
    .eq('operator_id', meTyped.operator_id);
  if (error) return { ok: false, error: error.message };

  // Enqueue notification so the bidder hears that the package is en
  // route. Idempotency key prevents double-notify if markShipped is
  // accidentally called twice.
  await admin
    .from('notifications_outbox')
    .insert({
      target_user_id: null, // resolved by the worker via invoice.bidder_id
      kind: 'shipment_dispatched',
      idempotency_key: `shipment_dispatched:${inv.id}`,
      payload: { invoice_id: inv.id },
    })
    .select('id')
    .maybeSingle();
  // (failure is non-fatal — the operator can still mark shipped; bidder
  // just doesn't get the push)

  revalidatePath('/shipping');
  return { ok: true };
}
