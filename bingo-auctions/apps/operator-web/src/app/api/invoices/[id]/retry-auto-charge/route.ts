// POST /api/invoices/[id]/retry-auto-charge
//
// 2026-05-21 (migration 0105): when a bidder's saved card declined at
// auction close, the invoice flips to 'payment_failed_grace' and the
// bidder has 48h to update their card. After updating, they can ask
// the auto-charge worker to retry with this endpoint.
//
// All this route does is INSERT a fresh row into auto_charge_jobs
// (idempotent via ON CONFLICT). The /api/cron/auto-charge-drain worker
// picks it up on its next pass (~1 min) and attempts the off-session
// PaymentIntent against the now-updated default_payment_method_id.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

type InvoiceRow = {
  id: string;
  status: string;
  bidder_id: string;
  grace_until: string | null;
  auto_charge_attempt_count: number | null;
};

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const caller = await verifyAuth(req);
  if (!caller) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();

  // Ownership + state checks. Service-role read so we don't have to
  // rely on the bidder's RLS visibility for an invoice that hasn't
  // been paid yet (some RLS policies hide post-grace rows).
  const { data: invRow, error: readErr } = await admin
    .from('invoices')
    .select('id, status, bidder_id, grace_until, auto_charge_attempt_count')
    .eq('id', id)
    .maybeSingle();

  if (readErr) {
    return NextResponse.json({ error: 'lookup_failed' }, { status: 500 });
  }
  const invoice = invRow as InvoiceRow | null;
  if (!invoice) {
    return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });
  }
  if (invoice.bidder_id !== caller.userId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Only retry while we're still in the grace window. Once the cron
  // flips to 'payment_failed_relisted' the lot is gone and a retry
  // would charge for a lot the bidder no longer owns.
  if (invoice.status !== 'payment_failed_grace') {
    return NextResponse.json(
      { error: 'not_in_grace', status: invoice.status },
      { status: 409 },
    );
  }

  // Enqueue. Migration 0105 set up auto_charge_jobs with invoice_id
  // as PK so ON CONFLICT keeps the request idempotent — a double-tap
  // during a slow network won't duplicate.
  //
  // attempt_count carries the invoice's recorded attempt count forward so the
  // worker's per-attempt Square idempotency key (`inv:<id>:<attempt+1>`)
  // ADVANCES on each retry. Hardcoding 0 here reused the first attempt's key
  // and made Square replay the original decline / throw IDEMPOTENCY_KEY_REUSED,
  // so an updated card could never be re-charged (2026-07-08 incident).
  const { error: enqErr } = await admin
    .from('auto_charge_jobs')
    .upsert(
      {
        invoice_id: invoice.id,
        bidder_id: invoice.bidder_id,
        next_attempt_at: new Date().toISOString(),
        attempt_count: invoice.auto_charge_attempt_count ?? 0,
        last_error: null,
      },
      { onConflict: 'invoice_id' },
    );

  if (enqErr) {
    return NextResponse.json(
      { error: 'enqueue_failed', detail: enqErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
