// POST /api/lottr/apply-enrichment
//   { importRowId: string, candidate: LotCandidate, fields: string[] }
//
// Applies the operator-approved subset of LotCandidate fields onto an
// existing import_row. The operator picks which fields to take, so we
// only patch what's in `fields`.

import { NextResponse } from 'next/server';
import {
  filterSafeImageUrls,
  resolveCategoryId,
  type LotCandidate,
} from '@auction-platform/domain-lotting';
import { getSupabaseServer } from '@/lib/supabase-server';

const ALLOWED_FIELDS = new Set<string>([
  'title',
  'description',
  'brand',
  'model',
  'category',
  'msrp',
  'startBid',
  'photos',
  'upc',
]);

export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: 'not_authenticated' }, { status: 401 });
  }
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!staff) {
    return NextResponse.json({ ok: false, reason: 'not_staff' }, { status: 403 });
  }

  let body: { importRowId?: string; candidate?: LotCandidate; fields?: string[] };
  try {
    body = (await req.json()) as {
      importRowId?: string;
      candidate?: LotCandidate;
      fields?: string[];
    };
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_json' }, { status: 400 });
  }

  const { importRowId, candidate, fields } = body;
  if (!importRowId || !candidate || !Array.isArray(fields)) {
    return NextResponse.json(
      { ok: false, reason: 'importRowId, candidate, fields required' },
      { status: 400 },
    );
  }

  const apply: string[] = fields.filter((f) => ALLOWED_FIELDS.has(f));
  if (apply.length === 0) {
    return NextResponse.json(
      { ok: false, reason: 'no fields to apply' },
      { status: 400 },
    );
  }

  // Build the patch — each accepted field maps onto an import_rows column.
  // Field names are LotCandidate names; column names follow the import_rows
  // schema (e.g., starting_bid → starting_bid_cents, photos → photo_url).
  const patch: Record<string, unknown> = {};
  if (apply.includes('title') && candidate.title) {
    patch['title'] = candidate.title.slice(0, 500);
  }
  if (
    apply.includes('description') &&
    (candidate.description || candidate.specs)
  ) {
    patch['description'] =
      (candidate.description || candidate.specs).slice(0, 5000);
  }
  if (apply.includes('msrp') && candidate.msrp != null && candidate.msrp > 0) {
    patch['msrp_cents'] = Math.round(candidate.msrp * 100);
  }
  if (
    apply.includes('startBid') &&
    candidate.startBid != null &&
    candidate.startBid > 0
  ) {
    patch['starting_bid_cents'] = Math.round(candidate.startBid * 100);
  }
  if (apply.includes('upc') && candidate.upc) {
    // Only set if it's a valid UPC shape; the import_rows.upc column is
    // for digits-only normalized values.
    if (/^\d{8,14}$/.test(candidate.upc)) patch['upc'] = candidate.upc;
  }
  if (apply.includes('category') && candidate.category) {
    patch['category_raw'] = candidate.category;
    const categoryId = await resolveCategoryId(supabase, candidate.category);
    if (categoryId) patch['category_id'] = categoryId;
  }
  if (apply.includes('photos') && candidate.stockPhotos.length > 0) {
    // Filter through the host allowlist — the candidate object is supplied
    // by the operator client, so stockPhotos may contain anything. Drop
    // non-https + non-allowlisted URLs before persisting. import_rows
    // stores a single photo_url; we take the first safe URL. (The full
    // array gets reapplied on the lot row when this row is lotted.)
    const safe = filterSafeImageUrls(candidate.stockPhotos);
    if (safe.length > 0) patch['photo_url'] = safe[0];
  }

  // Defense-in-depth: scope the update by operator_id + status='pending'
  // even though RLS enforces operator scope. The status guard prevents a
  // race where the row gets lotted between the queue render and the apply.
  const { error } = await supabase
    .from('import_rows')
    .update(patch)
    .eq('id', importRowId)
    .eq('operator_id', staff.operator_id as string)
    .eq('status', 'pending');
  if (error) {
    console.error('[apply-enrichment] update failed', { importRowId, error });
    return NextResponse.json(
      { ok: false, reason: 'apply_failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, applied: Object.keys(patch).length });
}
