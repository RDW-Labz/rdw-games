// GET /reports/bidder-zips/export[?from=&to=&location=&zip=&state=&city=]
//
// Bidders by ZIP (mig 0434; city/state from mig 0438) as CSV: same gate,
// timezone and RPC as the page (shared loader), so the file always matches
// the screen. Aggregates only. With 0438 data the last line credits GeoNames
// (CC BY 4.0 requires it).

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { bidderLocationCsv, sortBidderLocationRows } from '@/lib/bidder-location';
import { loadBidderZips } from '../data';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const supabase = await getSupabaseServer();
  const report = await loadBidderZips(supabase, {
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
    location: q.get('location') ?? undefined,
    zip: q.get('zip') ?? undefined,
    state: q.get('state') ?? undefined,
    city: q.get('city') ?? undefined,
  });
  if (!report.ok) {
    switch (report.status) {
      case 'no_user':
        return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
      case 'no_operator':
        return NextResponse.json({ ok: false, error: 'Not an operator' }, { status: 403 });
      case 'forbidden':
        return NextResponse.json({ ok: false, error: 'Admins or managers only' }, { status: 403 });
    }
  }
  const s = report.state;
  if (s.kind === 'needs_migration') {
    return NextResponse.json({ ok: false, error: 'This report needs migration 0434' }, { status: 503 });
  }
  if (s.kind === 'forbidden') {
    return NextResponse.json({ ok: false, error: 'Admins or managers only' }, { status: 403 });
  }
  if (s.kind === 'error') {
    return NextResponse.json({ ok: false, error: s.message }, { status: 500 });
  }

  const period = report.from && report.to ? `${report.from} to ${report.to}` : 'all time';
  const csv = bidderLocationCsv(sortBidderLocationRows(s.rows), {
    period,
    location: report.selectedName,
    zipPrefix: report.zipPrefix,
    timeZone: report.timeZone,
    places: report.places.available,
    state: report.places.state,
    city: report.places.city,
  });
  const slug = report.selectedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const zipPart = report.zipPrefix ? `-zip${report.zipPrefix}` : '';
  const placePart = report.places.state
    ? `-${[report.places.city, report.places.state].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
    : '';
  const filename = `bidders-by-zip-${slug}${zipPart}${placePart}-${report.from ?? 'all'}-${report.to ?? 'time'}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
