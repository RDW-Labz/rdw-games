// Identity verification — TEMPORARILY DISABLED (Square cutover).
//
// The Stripe Identity integration was removed with Stripe (Square has no ID-
// verification equivalent). A replacement provider (Persona / Veriff / Onfido)
// is a TODO — Michael chose "swap provider later" (option C). Until one is wired
// this route returns 503 so the app surfaces "verification unavailable" cleanly
// instead of 500-ing on a missing Stripe client.
//
// NOTE: the high-value-bid identity gate in place_bid() (DB) still exists; with
// no verification path a bidder can't clear it, so bids at/above
// IDENTITY_VERIFICATION_THRESHOLD_CENTS are effectively blocked until a provider
// is wired. Revisit at launch if high-value bids need to flow.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  return NextResponse.json(
    { error: 'identity_verification_unavailable' },
    { status: 503 },
  );
}
