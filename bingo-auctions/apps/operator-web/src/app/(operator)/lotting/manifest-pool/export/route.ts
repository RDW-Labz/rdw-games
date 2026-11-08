// GET /lotting/manifest-pool/export
//
// Streams pending manifest rows (import_rows with status='pending') as
// a CSV. Honors the same q and import filters as the page UI. Use case:
// hand the floor crew a printable "what's coming on truck X" list so
// they can pre-stage receiving.
//
// CSV columns:
//   import_filename, source_label, title, brand, model,
//   upc, asin, fnsku, lpn, external_code,
//   msrp_dollars, condition, category_raw, has_photo, created_at
//
// Filename: <OP>-manifest-pool[-<source>][-<q>]-<rowcount>rows-<date>.csv

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

type Row = {
  import_id: string | null;
  title: string | null;
  brand: string | null;
  model: string | null;
  upc: string | null;
  asin: string | null;
  fnsku: string | null;
  lpn: string | null;
  external_code: string | null;
  msrp_cents: number | null;
  photo_url: string | null;
  condition: string | null;
  category_raw: string | null;
  created_at: string;
  imports: { filename: string; source_label: string | null } | { filename: string; source_label: string | null }[] | null;
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
  const importFilter = (url.searchParams.get('import') ?? '').trim();

  let q = supabase
    .from('import_rows')
    .select(
      'import_id, title, brand, model, upc, asin, fnsku, lpn, external_code, msrp_cents, photo_url, condition, category_raw, created_at, imports(filename, source_label)',
    )
    .eq('operator_id', operatorId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5000);
  if (importFilter) q = q.eq('import_id', importFilter);
  if (searchQ) {
    q = q.or(
      [
        `title.ilike.%${searchQ}%`,
        `upc.ilike.${searchQ}%`,
        `asin.ilike.${searchQ}%`,
        `fnsku.ilike.${searchQ}%`,
        `lpn.ilike.${searchQ}%`,
        `external_code.ilike.${searchQ}%`,
        `brand.ilike.%${searchQ}%`,
        `model.ilike.${searchQ}%`,
      ].join(','),
    );
  }

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as unknown as Row[];

  const header = [
    'import_filename', 'source_label', 'title', 'brand', 'model',
    'upc', 'asin', 'fnsku', 'lpn', 'external_code',
    'msrp_dollars', 'condition', 'category_raw', 'has_photo', 'created_at',
  ];
  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    const importMeta = (() => {
      const imp = r.imports;
      if (!imp) return { filename: '', source_label: '' };
      if (Array.isArray(imp)) {
        const first = imp[0];
        return {
          filename: first?.filename ?? '',
          source_label: first?.source_label ?? '',
        };
      }
      return {
        filename: imp.filename ?? '',
        source_label: imp.source_label ?? '',
      };
    })();
    lines.push(
      [
        csvCell(importMeta.filename),
        csvCell(importMeta.source_label),
        csvCell(r.title),
        csvCell(r.brand),
        csvCell(r.model),
        csvCell(r.upc),
        csvCell(r.asin),
        csvCell(r.fnsku),
        csvCell(r.lpn),
        csvCell(r.external_code),
        csvCell(r.msrp_cents != null ? (r.msrp_cents / 100).toFixed(2) : ''),
        csvCell(r.condition),
        csvCell(r.category_raw),
        csvCell(r.photo_url ? 'yes' : 'no'),
        csvCell(r.created_at),
      ].join(','),
    );
  }

  const ts = new Date().toISOString().slice(0, 10);
  const filenameParts: string[] = [operatorCode, 'manifest-pool'];
  if (importFilter) filenameParts.push('import-' + importFilter.slice(0, 8));
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
