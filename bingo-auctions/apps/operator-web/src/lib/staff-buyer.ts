// "Sold to" on staff screens (2026-10-28). The bidders table only lets a
// customer read their own row (RLS bidders_self_read), so a staff session
// embedding bidders(...) always gets null and the console printed "—" for
// every sold lot. Instead of loosening bidders RLS, the server reads the few
// display fields with the service role, and only after checking that the
// signed-in viewer is staff of the operator the invoice belongs to.
//
// Server-only: never import from a client component.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export type StaffBuyer = {
  display_name: string | null;
  email: string | null;
  bidder_number: number | null;
};

/**
 * Buyer display fields for an invoice, or null when the viewer is not staff
 * of that invoice's operator (or anything fails). `viewer` is the request's
 * own client (RLS as the signed-in user); `admin` is the service-role client.
 */
export async function loadBuyerForStaff(
  viewer: SupabaseClient,
  admin: SupabaseClient,
  invoiceId: string,
): Promise<StaffBuyer | null> {
  try {
    const {
      data: { user },
    } = await viewer.auth.getUser();
    if (!user) return null;
    const [{ data: me }, { data: inv }] = await Promise.all([
      viewer.from('operator_users').select('operator_id').eq('user_id', user.id).maybeSingle(),
      admin.from('invoices').select('operator_id, bidder_id').eq('id', invoiceId).maybeSingle(),
    ]);
    const myOp = (me as { operator_id: string } | null)?.operator_id;
    const invRow = inv as { operator_id: string; bidder_id: string } | null;
    if (!myOp || !invRow || invRow.operator_id !== myOp) return null;
    const { data: b } = await admin
      .from('bidders')
      .select('display_name, email, bidder_number')
      .eq('id', invRow.bidder_id)
      .maybeSingle();
    return (b as StaffBuyer | null) ?? null;
  } catch {
    return null;
  }
}
