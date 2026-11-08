// GET /marketing/audience/export?segment=buyers|dormant
//
// Streams a Meta Custom Audience CSV. Built for the ad launch: the cold
// campaign has to EXCLUDE people who already buy from us, or the budget goes
// on reacquiring customers who were going to bid anyway and the reported ROAS
// flatters itself.
//
// ── EVERY VALUE IS HASHED BEFORE IT LEAVES THIS PROCESS ──────────────────────
// The file contains SHA-256 of the email and phone, never the address itself.
// Meta detects a 64-char hex value and matches on it exactly as it would on the
// raw value, so nothing is lost — but a downloaded audience file sitting in
// someone's Downloads folder is then not a customer list. hashPii() is imported
// from the Conversions API module rather than reimplemented so the
// normalisation (trim + lowercase for email, digits-only for phone) is
// guaranteed identical to what the CAPI drain already sends; a mismatch there
// would silently split the same person into two unmatchable records.
//
// ── OPT-OUTS ARE EXCLUDED, NOT JUST SUPPRESSED ───────────────────────────────
// bidders.ad_tracking_opt_out (mig 0340) filters both segments. Uploading an
// opted-out person's hashed email to Meta IS the sharing they declined — the
// hash is still an identifier, and the privacy policy says we stop, not that we
// stop except when building audiences.
//
// Segments:
//   buyers  — has at least one paid invoice. Use as the EXCLUSION audience on
//             cold prospecting.
//   dormant — registered, never placed a bid. 396 people as of launch, 391 of
//             them email-reachable. Cheap to target directly; they have already
//             cleared the step that costs the most to buy.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { hashPii } from '@/lib/social/meta-capi';

export const runtime = 'nodejs';

type Segment = 'buyers' | 'dormant';

function parseSegment(raw: string | null): Segment | null {
  return raw === 'buyers' || raw === 'dormant' ? raw : null;
}

export async function GET(req: NextRequest) {
  const segment = parseSegment(new URL(req.url).searchParams.get('segment'));
  if (!segment) {
    return NextResponse.json(
      { ok: false, error: "segment must be 'buyers' or 'dormant'" },
      { status: 400 },
    );
  }

  // Same gate as the other operator exports: a real session, and membership of
  // an operator. This reads across all bidders, so it must never be reachable
  // by a signed-in bidder.
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!staff) return NextResponse.json({ ok: false, error: 'Not an operator' }, { status: 403 });

  const admin = getSupabaseAdmin();

  // Which bidder ids belong in the segment. Both lists are small (hundreds), so
  // membership is resolved in memory rather than with a join the PostgREST
  // client would have to express as an embed.
  const { data: paidRows, error: paidErr } = await admin
    .from('invoices')
    .select('bidder_id')
    .eq('status', 'paid')
    .not('bidder_id', 'is', null);
  if (paidErr) return NextResponse.json({ ok: false, error: paidErr.message }, { status: 500 });
  const buyerIds = new Set((paidRows ?? []).map((r) => (r as { bidder_id: string }).bidder_id));

  let bidderIds: Set<string> | null = null;
  if (segment === 'dormant') {
    const { data: bidRows, error: bidErr } = await admin.from('bids').select('bidder_id');
    if (bidErr) return NextResponse.json({ ok: false, error: bidErr.message }, { status: 500 });
    bidderIds = new Set((bidRows ?? []).map((r) => (r as { bidder_id: string }).bidder_id));
  }

  const { data: bidders, error: bErr } = await admin
    .from('bidders')
    .select('id, email, phone, ad_tracking_opt_out')
    .limit(50_000);
  if (bErr) return NextResponse.json({ ok: false, error: bErr.message }, { status: 500 });

  type BidderRow = {
    id: string;
    email: string | null;
    phone: string | null;
    ad_tracking_opt_out: boolean | null;
  };

  const lines: string[] = ['email,phone'];
  let optedOut = 0;
  let unmatchable = 0;

  for (const row of (bidders ?? []) as BidderRow[]) {
    const inSegment =
      segment === 'buyers' ? buyerIds.has(row.id) : !buyerIds.has(row.id) && !bidderIds!.has(row.id);
    if (!inSegment) continue;

    if (row.ad_tracking_opt_out) {
      optedOut += 1;
      continue;
    }

    const em = hashPii(row.email, 'email');
    const ph = hashPii(row.phone, 'phone');
    // A row with neither identifier cannot match anyone at Meta; writing it
    // would only inflate the "not matched" figure in Ads Manager and make a
    // healthy upload look broken.
    if (!em && !ph) {
      unmatchable += 1;
      continue;
    }
    lines.push(`${em ?? ''},${ph ?? ''}`);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="bingo-${segment}-${stamp}.csv"`,
      // Counts travel in headers so the operator can sanity-check the upload
      // against Ads Manager without the CSV carrying commentary rows that would
      // be parsed as data.
      'x-audience-rows': String(lines.length - 1),
      'x-audience-opted-out': String(optedOut),
      'x-audience-unmatchable': String(unmatchable),
      'cache-control': 'no-store',
    },
  });
}
