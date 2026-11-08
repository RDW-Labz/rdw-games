// GET /reports/missing/export[?all=1]
//
// The Missing Items report (mig 0426) as CSV — same rows and gate as the page
// (shared loader). Default: unresolved only; ?all=1 adds resolved items.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { MISSING_CSV_HEADER, loadMissingReport, missingCsvLine } from '@/lib/missing-items-report';

export async function GET(req: NextRequest) {
  const all = req.nextUrl.searchParams.get('all') === '1';
  const supabase = await getSupabaseServer();
  const report = await loadMissingReport(supabase, all);
  if (!report.ok) {
    switch (report.status) {
      case 'no_user':
        return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
      case 'no_operator':
        return NextResponse.json({ ok: false, error: 'Not an operator' }, { status: 403 });
      case 'error':
        return NextResponse.json({ ok: false, error: report.message }, { status: 500 });
    }
  }

  const lines = [MISSING_CSV_HEADER.join(','), ...report.rows.map(missingCsvLine)];
  const filename = `missing-items-${all ? 'all' : 'open'}-${report.rows.length}rows-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
