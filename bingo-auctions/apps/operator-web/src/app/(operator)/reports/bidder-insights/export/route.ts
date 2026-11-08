// GET /reports/bidder-insights/export[?from=&to=&zip=]
//
// ZIP heat table (mig 0449) as CSV: same gate, timezone and RPC as the page
// (shared loader), so the file always matches the screen. Aggregates only.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { zipHeatCsv } from '@/lib/bidder-insights';
import { loadBidderInsights } from '../data';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const supabase = await getSupabaseServer();
  const report = await loadBidderInsights(supabase, {
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
    zip: q.get('zip') ?? undefined,
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
  const s = report.zipHeat;
  if (s.kind === 'needs_migration') {
    return NextResponse.json({ ok: false, error: 'This report needs migration 0449' }, { status: 503 });
  }
  if (s.kind === 'forbidden') {
    return NextResponse.json({ ok: false, error: 'Admins or managers only' }, { status: 403 });
  }
  if (s.kind === 'error') {
    return NextResponse.json({ ok: false, error: s.message }, { status: 500 });
  }

  const period = report.from && report.to ? `${report.from} to ${report.to}` : 'all time';
  const csv = zipHeatCsv(s.rows, { period, zipPrefix: report.zipPrefix });
  const zipPart = report.zipPrefix ? `-zip${report.zipPrefix}` : '';
  const filename = `bidder-zip-heat${zipPart}-${report.from ?? 'all'}-${report.to ?? 'time'}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
