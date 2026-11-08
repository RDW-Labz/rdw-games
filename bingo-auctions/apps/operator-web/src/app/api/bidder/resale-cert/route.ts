// POST /api/bidder/resale-cert — bidder submits a resale certificate
// (sales-tax permit) for tax-exempt purchasing (mig 0233).
//
// Sets status 'pending' for operator review; ALWAYS clears tax_exempt so a
// resubmission can't keep an old approval alive while new details await
// review. Approval happens in the operator console (bidders/[id]).

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  let body: { permit?: string; state?: string; business_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const permit = (body.permit ?? '').trim().toUpperCase();
  const state = (body.state ?? '').trim().toUpperCase();
  const business = (body.business_name ?? '').trim();

  if (!/^[A-Z0-9][A-Z0-9-]{2,24}$/.test(permit)) {
    return NextResponse.json(
      { ok: false, error: 'Enter your sales-tax permit number (3–25 letters/numbers).' },
      { status: 400 },
    );
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return NextResponse.json(
      { ok: false, error: 'Enter the 2-letter state that issued the permit (e.g. AR).' },
      { status: 400 },
    );
  }
  if (business.length < 2 || business.length > 120) {
    return NextResponse.json(
      { ok: false, error: 'Enter the business name on the permit.' },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('bidders')
    .update({
      resale_cert_permit: permit,
      resale_cert_state: state,
      resale_cert_business: business,
      resale_cert_status: 'pending',
      resale_cert_submitted_at: new Date().toISOString(),
      resale_cert_reviewed_at: null,
      tax_exempt: false,
    })
    .eq('id', caller.userId);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
