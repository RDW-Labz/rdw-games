// GET /reports/kept/export
//
// The Kept items report (mig 0381) as a CSV — same rows, same admin/manager
// gate (shared loader). Kept items are not sales and carry no revenue.
//
// CSV columns: kept_at, lot_code, title, kept_price_dollars, reason, kept_by,
//              prior_status
// Filename: kept-items-<rowcount>rows-<date>.csv

import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { KEPT_CSV_HEADER, keptCsvLine } from '@/lib/keep-for-business';
import { loadKeptReport } from '../data';

export async function GET() {
  const supabase = await getSupabaseServer();
  const report = await loadKeptReport(supabase);
  if (!report.ok) {
    switch (report.status) {
      case 'no_user':
        return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
      case 'no_operator':
        return NextResponse.json({ ok: false, error: 'Not an operator' }, { status: 403 });
      case 'forbidden':
        return NextResponse.json({ ok: false, error: 'Admins or managers only' }, { status: 403 });
      case 'error':
        return NextResponse.json({ ok: false, error: report.message }, { status: 500 });
    }
  }

  const lines: string[] = [KEPT_CSV_HEADER.join(',')];
  for (const r of report.rows) {
    lines.push(keptCsvLine(r, report.staffNames.get(r.kept_by) ?? null));
  }

  const filename = `kept-items-${report.rows.length}rows-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
