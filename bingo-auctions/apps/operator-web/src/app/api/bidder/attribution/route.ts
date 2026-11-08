// POST /api/bidder/attribution — store the Meta click identifiers for a
// signed-in bidder (mig 0341).
//
// The browser is the only place _fbp and _fbc exist; the Conversions API drain
// runs from Postgres and has no session to read them from. This route is the
// bridge, and it is the difference between Meta knowing "someone bought" and
// Meta knowing "the person who clicked that ad bought".
//
// Called opportunistically on storefront page loads (MetaAttribution), not at
// one specific moment, because the click and the account can be days apart: a
// visitor clicks an ad on Monday, browses, and registers on Thursday. Writing
// on every visit means whichever visit they happen to be signed in on is the
// one that lands.
//
// Deliberately NOT accepting an IP or user agent. Meta's alternative matching
// route wants both, and storing bidder IPs for advertising would be a new
// category of personal information with a privacy-policy paragraph attached.
// _fbp/_fbc are identifiers Meta already set in that browser.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

/** Both cookies are "fb.<subdomainIndex>.<timestamp>.<payload>". Validating the
 *  shape keeps arbitrary caller-supplied strings out of a column that is later
 *  forwarded verbatim to Meta — this is a public endpoint and the body is not
 *  trustworthy just because the session is. */
const FB_COOKIE = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{1,512}$/;

function clean(v: unknown): string | null {
  return typeof v === 'string' && FB_COOKIE.test(v) ? v : null;
}

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body: { fbp?: unknown; fbc?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }

  const fbp = clean(body.fbp);
  const fbc = clean(body.fbc);
  if (!fbp && !fbc) return NextResponse.json({ ok: true, stored: false });

  const admin = getSupabaseAdmin();

  // Refuse for opted-out bidders. The 0341 trigger already clears these on
  // opt-out, but without this check the next page load would write them
  // straight back — the opt-out has to hold against a client that keeps
  // reporting, not just against the moment it was set.
  const { data: bidder } = await admin
    .from('bidders')
    .select('ad_tracking_opt_out, meta_fbc')
    .eq('id', caller.userId)
    .maybeSingle();
  const row = bidder as { ad_tracking_opt_out?: boolean; meta_fbc?: string | null } | null;
  if (!row) return NextResponse.json({ ok: false, error: 'No such bidder' }, { status: 404 });
  if (row.ad_tracking_opt_out) return NextResponse.json({ ok: true, stored: false });

  // _fbc is the valuable one and it only appears on an ad-click landing, so a
  // later visit with no fbclid must not erase the one we have. _fbp is safe to
  // refresh: it identifies the browser, and the newest is the most useful.
  const patch: Record<string, string> = { meta_attribution_at: new Date().toISOString() };
  if (fbp) patch.meta_fbp = fbp;
  if (fbc) patch.meta_fbc = fbc;

  const { error } = await admin.from('bidders').update(patch).eq('id', caller.userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, stored: true, hasClickId: Boolean(fbc || row.meta_fbc) });
}
