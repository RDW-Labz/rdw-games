// GET /lotting/inventory/export
//
// Streams the operator's inventory as a CSV. Honors the same filters
// as the /lotting/inventory page (status, search, source, has_photos,
// has_msrp, has_category) so the operator's exported file matches
// what they see on screen.
//
// CSV columns chosen for accounting / cleanup workflow:
//   lot_code, title, status, source, condition, msrp_cents,
//   starting_bid_cents, category, intake_bin, intake_at, created_at,
//   photo_count, external_code, has_photos, has_msrp
//
// Returns text/csv with a deterministic filename including the
// operator's code + ISO timestamp so multiple exports don't overwrite.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

type Row = {
  lot_code: string;
  title: string;
  status: string;
  source: string | null;
  condition: string;
  msrp_cents: number | null;
  starting_bid_cents: number;
  category: string | null;
  intake_bin_id: string | null;
  intake_at: string | null;
  created_at: string;
  photo_urls: string[] | null;
  external_code: string | null;
  bins: { code: string } | { code: string }[] | null;
};

// CSV-escape a field. RFC 4180: enclose in double-quotes if the field
// contains comma, double-quote, or newline. Embedded double-quotes are
// doubled.
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
  const { data: { user } } = await supabase.auth.getUser();
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
  const operatorId = staff.operator_id as string;
  const operatorCode = (() => {
    const op = (staff as { operators?: { code?: string } | { code?: string }[] }).operators;
    if (Array.isArray(op)) return op[0]?.code ?? 'op';
    return op?.code ?? 'op';
  })();

  // Parse filters from the URL — same set the page UI uses, plus a
  // bonus "missing" filter to slice cleanup-relevant subsets.
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get('status'); // 'pending_intake' | 'in_inventory' | null
  const searchQ = (url.searchParams.get('q') ?? '').trim();
  const sourceFilter = (url.searchParams.get('source') ?? '').trim();
  const missing = url.searchParams.get('missing'); // 'photos' | 'msrp' | 'category' | null

  let q = supabase
    .from('lots')
    .select(
      'lot_code, title, status, source, condition, msrp_cents, starting_bid_cents, category, intake_bin_id, intake_at, created_at, photo_urls, external_code, bins(code)',
    )
    .eq('operator_id', operatorId)
    .is('auction_id', null)
    .is('deleted_at', null) // 0057: don't export trashed
    .in('status', ['pending_intake', 'in_inventory'])
    .order('created_at', { ascending: false })
    .limit(5000);

  if (statusFilter === 'pending_intake' || statusFilter === 'in_inventory') {
    q = q.eq('status', statusFilter);
  }
  if (searchQ) {
    q = q.or(`lot_code.ilike.${searchQ}%,title.ilike.%${searchQ}%`);
  }
  if (sourceFilter) {
    q = q.eq('source', sourceFilter);
  }
  if (missing === 'photos') {
    // Lot has no photos: empty array OR null. PostgREST or() lets us
    // express both — array eq '{}' OR is null.
    q = q.or('photo_urls.eq.{},photo_urls.is.null');
  } else if (missing === 'msrp') {
    q = q.is('msrp_cents', null);
  } else if (missing === 'category') {
    q = q.is('category', null);
  }

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Row[];

  const header = [
    'lot_code', 'title', 'status', 'source', 'condition',
    'msrp_dollars', 'starting_bid_dollars',
    'category', 'intake_bin', 'intake_at', 'created_at',
    'photo_count', 'external_code', 'has_photos', 'has_msrp',
  ];

  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    const photoCount = Array.isArray(r.photo_urls) ? r.photo_urls.length : 0;
    const binCode = (() => {
      const b = r.bins;
      if (!b) return '';
      if (Array.isArray(b)) return b[0]?.code ?? '';
      return b.code ?? '';
    })();
    lines.push(
      [
        csvCell(r.lot_code),
        csvCell(r.title),
        csvCell(r.status),
        csvCell(r.source),
        csvCell(r.condition),
        csvCell(r.msrp_cents != null ? (r.msrp_cents / 100).toFixed(2) : ''),
        csvCell((r.starting_bid_cents / 100).toFixed(2)),
        csvCell(r.category),
        csvCell(binCode),
        csvCell(r.intake_at),
        csvCell(r.created_at),
        csvCell(photoCount),
        csvCell(r.external_code),
        csvCell(photoCount > 0 ? 'yes' : 'no'),
        csvCell(r.msrp_cents != null ? 'yes' : 'no'),
      ].join(','),
    );
  }

  // Filename encodes scope so the operator knows what they downloaded
  // weeks later. Format: <OP>-inventory[-<source>][-<status>][-<missing>]-<rowcount>rows-<date>.csv
  //   CLU-inventory-Truck-47L-in_inventory-87rows-2026-05-10.csv
  //   CLU-inventory-2026-05-10.csv  (no filters)
  const ts = new Date().toISOString().slice(0, 10); // date only — operator-friendly
  const filenameParts: string[] = [operatorCode, 'inventory'];
  if (sourceFilter) {
    // Slugify the source so e.g. "Truck 47L 5/9" → "Truck-47L-5-9".
    const slug = sourceFilter
      .trim()
      .replace(/[/\\?#%]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (slug) filenameParts.push(slug);
  }
  if (statusFilter === 'pending_intake' || statusFilter === 'in_inventory') {
    filenameParts.push(statusFilter);
  }
  if (missing) filenameParts.push('missing-' + missing);
  if (searchQ) filenameParts.push('q-' + searchQ.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 30));
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
