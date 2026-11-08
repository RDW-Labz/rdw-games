// Operator-side: buy the shipping label for a paid invoice.
//
// Flow:
//   1. Auth caller — must be operator admin or manager for the
//      invoice's operator.
//   2. Verify invoice: status='paid', fulfillment_method='ship',
//      easypost_shipment_id + easypost_rate_id present (from the
//      bidder's quote at checkout), shipped_at IS NULL.
//   3. Call EasyPost to buy the label.
//   4. Download the label PDF and stash it in Supabase Storage
//      (operator-only bucket).
//   5. Update invoice with label URL + tracking number + carrier +
//      shipping_label_purchased_at timestamp.
//   6. Return the storage URL so the operator's browser opens the PDF.
//
// Idempotency: if the invoice already has a label, return the existing
// URL instead of buying a second one (which would charge twice).

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { buyLabel } from '@/lib/easypost';

export const runtime = 'nodejs';

const bodySchema = z.object({
  invoiceId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
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
  if (!['admin', 'manager'].includes(meTyped.role)) {
    return NextResponse.json({ error: 'insufficient_role' }, { status: 403 });
  }

  let body;
  try {
    body = bodySchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!body.success) {
    return NextResponse.json(
      { error: 'invalid_body', detail: body.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();

  const { data: invoiceRow } = await admin
    .from('invoices')
    .select(
      'id, operator_id, status, fulfillment_method, easypost_shipment_id, easypost_rate_id, shipping_label_url, shipping_tracking_number, shipping_carrier, shipped_at',
    )
    .eq('id', body.data.invoiceId)
    .single();

  if (!invoiceRow) {
    return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });
  }

  const inv = invoiceRow as {
    id: string;
    operator_id: string;
    status: string;
    fulfillment_method: string | null;
    easypost_shipment_id: string | null;
    easypost_rate_id: string | null;
    shipping_label_url: string | null;
    shipping_tracking_number: string | null;
    shipping_carrier: string | null;
    shipped_at: string | null;
  };

  if (inv.operator_id !== meTyped.operator_id) {
    return NextResponse.json({ error: 'invoice_other_operator' }, { status: 403 });
  }
  if (inv.status !== 'paid') {
    return NextResponse.json({ error: 'invoice_not_paid' }, { status: 409 });
  }
  if (inv.fulfillment_method !== 'ship') {
    return NextResponse.json({ error: 'not_a_ship_invoice' }, { status: 409 });
  }

  // Idempotent: if a label already exists, return it. This protects
  // against a double-click from the operator buying two labels.
  if (inv.shipping_label_url) {
    return NextResponse.json({
      ok: true,
      labelUrl: inv.shipping_label_url,
      trackingNumber: inv.shipping_tracking_number,
      carrier: inv.shipping_carrier,
      alreadyBought: true,
    });
  }

  if (!inv.easypost_shipment_id || !inv.easypost_rate_id) {
    return NextResponse.json(
      {
        error: 'no_quote_on_file',
        message:
          'Invoice has no shipment/rate ids. The bidder may have skipped the shipping-quote step at checkout.',
      },
      { status: 422 },
    );
  }

  // Buy the label via EasyPost.
  let shipment;
  try {
    shipment = await buyLabel({
      shipmentId: inv.easypost_shipment_id,
      rateId: inv.easypost_rate_id,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'easypost_buy_failed', message: (err as Error).message },
      { status: 502 },
    );
  }

  const labelPdfUrl = shipment.postage_label?.label_pdf_url ?? shipment.postage_label?.label_url;
  const trackingCode = shipment.tracking_code ?? null;
  const carrier = shipment.selected_rate?.carrier ?? null;

  if (!labelPdfUrl) {
    return NextResponse.json(
      { error: 'easypost_no_label_url', message: 'EasyPost returned a shipment without a label URL.' },
      { status: 502 },
    );
  }

  // Mirror the label PDF into our private storage bucket. The column
  // stores the storage PATH (not URL) — labels expose bidder PII so we
  // serve them through /api/shipping/label/[invoiceId] which auth-checks
  // and returns a short-lived signed URL.
  let storagePath: string | null = null;
  try {
    const pdfRes = await fetch(labelPdfUrl);
    if (pdfRes.ok) {
      const buf = new Uint8Array(await pdfRes.arrayBuffer());
      const path = `${meTyped.operator_id}/${inv.id}-${Date.now()}.pdf`;
      const { error: upErr } = await admin.storage
        .from('shipping-labels')
        .upload(path, buf, {
          contentType: 'application/pdf',
          cacheControl: '31536000',
          upsert: false,
        });
      if (!upErr) {
        storagePath = path;
      } else {
        console.warn('[shipping/buy-label] storage upload failed:', upErr.message);
      }
    }
  } catch (err) {
    console.warn('[shipping/buy-label] PDF mirror failed:', (err as Error).message);
  }

  // If our storage mirror succeeded, persist the path so future fetches
  // go through our auth-gated proxy. If it failed, fall back to the
  // raw EasyPost URL (operator can still download — just no PII gate).
  const persistValue = storagePath ?? labelPdfUrl;

  const now = new Date().toISOString();
  await admin
    .from('invoices')
    .update({
      shipping_label_url: persistValue,
      shipping_tracking_number: trackingCode,
      shipping_carrier: carrier,
      shipping_label_purchased_at: now,
      updated_at: now,
    } as never)
    .eq('id', inv.id);

  // The browser-facing download URL: always the proxy route. It handles
  // both the storage-path case (signed URL redirect) and the raw EasyPost
  // case (mostly a fallback for ops monitoring).
  const downloadUrl = `/api/shipping/label/${inv.id}`;

  return NextResponse.json({
    ok: true,
    labelUrl: downloadUrl,
    trackingNumber: trackingCode,
    carrier,
    alreadyBought: false,
  });
}
