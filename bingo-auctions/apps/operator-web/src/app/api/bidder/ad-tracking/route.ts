// POST /api/bidder/ad-tracking — record a signed-in bidder's advertising
// opt-out (mig 0340).
//
// The browser half of the opt-out lives in localStorage and covers the Pixel.
// This is the SERVER half, and it is the one that matters more: the
// Conversions API sends account, first-bid and purchase events straight from
// our database, so clearing a browser would otherwise silently resume sharing
// for someone who had opted out. Persisting it against the bidder makes the
// choice survive a new device, a new browser and a cleared cache.
//
// Setting the flag also retires anything already queued for that bidder — the
// trigger in 0340 does that — so an opt-out stops events that were enqueued
// minutes ago, not just future ones.
//
// GET is offered so the page can render the real current state rather than
// assuming localStorage and the database agree.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('bidders')
    .select('ad_tracking_opt_out')
    .eq('id', caller.userId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    optedOut: Boolean((data as { ad_tracking_opt_out?: boolean } | null)?.ad_tracking_opt_out),
  });
}

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body: { optOut?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }
  if (typeof body.optOut !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'optOut must be a boolean' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('bidders')
    .update({
      ad_tracking_opt_out: body.optOut,
      // Stamped only when opting OUT, so the row records when the request was
      // made. Opting back in clears it rather than leaving a misleading date.
      ad_tracking_opt_out_at: body.optOut ? new Date().toISOString() : null,
    })
    .eq('id', caller.userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, optedOut: body.optOut });
}
