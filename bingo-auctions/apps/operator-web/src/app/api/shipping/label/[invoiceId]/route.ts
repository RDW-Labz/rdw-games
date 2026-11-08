// Serve a shipping label PDF to the operator. We keep the
// shipping-labels bucket private (labels expose bidder PII) and proxy
// reads through this route after auth-checking that the caller is an
// operator staff member for the invoice's operator.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await context.params;

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) {
    return NextResponse.json({ error: 'not_operator_staff' }, { status: 403 });
  }
  const meTyped = me as { operator_id: string; role: string };

  const admin = getSupabaseAdmin();
  const { data: invoiceRow } = await admin
    .from('invoices')
    .select('id, operator_id, shipping_label_url')
    .eq('id', invoiceId)
    .single();
  if (!invoiceRow) {
    return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });
  }
  const inv = invoiceRow as { operator_id: string; shipping_label_url: string | null };
  if (inv.operator_id !== meTyped.operator_id) {
    return NextResponse.json({ error: 'invoice_other_operator' }, { status: 403 });
  }
  if (!inv.shipping_label_url) {
    return NextResponse.json({ error: 'no_label_yet' }, { status: 404 });
  }

  // shipping_label_url stores the storage path (within shipping-labels
  // bucket). Generate a short-lived signed URL and redirect — short
  // enough that a stale browser tab can't grab the PDF a week later.
  // The path is everything after '/shipping-labels/' if the column
  // happens to contain a full URL (from a stray earlier write).
  let storagePath = inv.shipping_label_url;
  const marker = '/shipping-labels/';
  if (storagePath.includes(marker)) {
    storagePath = storagePath.slice(storagePath.indexOf(marker) + marker.length);
  }

  const { data: signed, error: signErr } = await admin.storage
    .from('shipping-labels')
    .createSignedUrl(storagePath, 60 * 10); // 10 minutes

  if (signErr || !signed) {
    return NextResponse.json(
      { error: 'sign_failed', message: signErr?.message ?? 'unknown' },
      { status: 500 },
    );
  }

  return NextResponse.redirect(signed.signedUrl);
}
