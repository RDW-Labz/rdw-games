// Create an invoice's pickups row once it is paid (ensure_pickup_row, mig 0094).
//
// Staff's QR pickup scan (staff_scan_bidder_token) and the bidder's Pickup Pass
// only list invoices that HAVE a pickups row, so a paid invoice without one is
// invisible at the counter. Every path that marks an invoice paid calls this:
// the Square webhook backstop, staff mark-paid, and the auto-charge drain.
//
// Best-effort by design: the money has already moved by the time this runs, so
// a failure must never undo or fail the payment. It logs and returns false.
//
// Both failure shapes are caught. supabase-js reports an RPC error (e.g. P0001
// invoice_has_no_warehouse_lots) in the returned `error`, NOT by throwing — the
// callers used to only try/catch, so those failures vanished without a log.
//
// Callers keep their own ship check: ship invoices go to the shipping queue
// and must not get a pickups row. The RPC itself does not check.
//
// Log line (grep "ensure_pickup_row failed"):
//   [<context>] ensure_pickup_row failed for invoice <invoice_id> <message>

import type { SupabaseClient } from '@supabase/supabase-js';

type Admin = SupabaseClient<any, any, any>;

export async function ensurePickupRow(
  admin: Admin,
  invoiceId: string,
  context: string,
): Promise<boolean> {
  let message: string;
  try {
    const { error } = await admin.rpc('ensure_pickup_row', { p_invoice_id: invoiceId });
    if (!error) return true;
    message = error.message;
  } catch (err) {
    message = (err as Error)?.message ?? String(err);
  }
  console.warn(`[${context}] ensure_pickup_row failed for invoice`, invoiceId, message);
  return false;
}
