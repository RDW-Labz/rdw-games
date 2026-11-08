// GET /lotting/drafts/export
//
// Streams field-lotted drafts (lots with status='pending_intake', i.e.
// labeled but not yet binned) as a CSV. Useful for reconciling a
// physical staging area against the system — print the list, walk the
// shelves, check off what's there, queue up the picker app for what's
// missing.
//
// CSV columns:
//   lot_code, title, source, condition, msrp_dollars,
//   starting_bid_dollars, category, photo_count, has_photos,
//   created_at
//
// Filename: <OP>-drafts-<rowcount>rows-<date>.csv

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

type Row = {
  lot_code: string;
  title: string;
  source: string | null;
  condition: string;
  msrp_cents: number | null;
  starting_bid_cents: number;
  category: string | null;
  photo_urls: string[] | null;
  external_code: string | null;
  created_at: string;
};

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export async function GET(req: NextRequest) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, operators(code)')
    .eq('user_id', user.id)
    .single();
  if (!staff) {
    return NextResponse.json({ ok: false, error: 'Not an operator' }, { status: 403 });
  }
  const operatorId = (staff as { operator_id: string }).operator_id;
  const operatorCode = (() => {
    const op = (staff as { operators?: { code?: string } | { code?: string }[] }).operators;
    if (Array.isArray(op)) return op[0]?.code ?? 'op';
    return op?.code ?? 'op';
  })();

  const url = new URL(req.url);
  const searchQ = (url.searchParams.get('q') ?? '').trim();
  const sourceFilter = (url.searchParams.get('source') ?? '').trim();

  let q = supabase
    .from('lots')
    .select(
      'lot_code, title, source, condition, msrp_cents, starting_bid_cents, category, photo_urls, external_code, created_at',
    )
    .eq('operator_id', operatorId)
    .eq('status', 'pending_intake')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (searchQ) q = q.or(`lot_code.ilike.${searchQ}%,title.ilike.%${searchQ}%`);
  if (sourceFilter) q = q.eq('source', sourceFilter);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Row[];

  const header = [
    'lot_code', 'title', 'source', 'condition',
    'msrp_dollars', 'starting_bid_dollars', 'category',
    'photo_count', 'has_photos', 'external_code', 'created_at',
  ];
  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    const photoCount = Array.isArray(r.photo_urls) ? r.photo_urls.length : 0;
    lines.push(
      [
        csvCell(r.lot_code),
        csvCell(r.title),
        csvCell(r.source),
        csvCell(r.condition),
        csvCell(r.msrp_cents != null ? (r.msrp_cents / 100).toFixed(2) : ''),
        csvCell((r.starting_bid_cents / 100).toFixed(2)),
        csvCell(r.category),
        csvCell(photoCount),
        csvCell(photoCount > 0 ? 'yes' : 'no'),
        csvCell(r.external_code),
        csvCell(r.created_at),
      ].join(','),
    );
  }

  const ts = new Date().toISOString().slice(0, 10);
  const filenameParts: string[] = [operatorCode, 'drafts'];
  if (sourceFilter) {
    const slug = sourceFilter
      .trim()
      .replace(/[/\\?#%]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (slug) filenameParts.push(slug);
  }
  if (searchQ) {
    filenameParts.push('q-' + searchQ.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 30));
  }
  filenameParts.push(rows.length + 'rows');
  filenameParts.push(ts);
  const filename = filenameParts.join('-') + '.csv';

  return new NextResponse(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
