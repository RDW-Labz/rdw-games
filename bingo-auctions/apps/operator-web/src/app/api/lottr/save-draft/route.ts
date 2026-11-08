// POST /api/lottr/save-draft  { candidate: LotCandidate, photoUrls?: string[] }
//
// Persist a LotCandidate as a pending_intake row in lots, scoped to
// the calling staff member's operator. Same path the field-mobile
// app uses, just exposed as an HTTP endpoint so the desktop classifier
// can save N candidates in a loop without giving the browser direct
// supabase writes (we already do that, but this keeps the operator-
// web flow consistent).

import { NextResponse } from 'next/server';
import {
  createDraftLotFromCandidate,
  filterSafeImageUrls,
  type LotCandidate,
} from '@auction-platform/domain-lotting';
import { getSupabaseServer } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, reason: 'not_authenticated' },
      { status: 401 },
    );
  }
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!staff) {
    return NextResponse.json(
      { ok: false, reason: 'not_staff' },
      { status: 403 },
    );
  }

  let body: { candidate?: LotCandidate; photoUrls?: string[]; source?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_json' }, { status: 400 });
  }
  if (!body.candidate) {
    return NextResponse.json(
      { ok: false, reason: 'candidate required' },
      { status: 400 },
    );
  }

  // Filter the operator-supplied candidate.stockPhotos AND any explicit
  // photoUrls override through the host allowlist. The candidate object
  // came across the wire from the client, so we treat it as untrusted.
  const safeCandidate: LotCandidate = {
    ...body.candidate,
    stockPhotos: filterSafeImageUrls(body.candidate.stockPhotos ?? []),
  };
  const safePhotoUrls = body.photoUrls
    ? filterSafeImageUrls(body.photoUrls)
    : undefined;

  const result = await createDraftLotFromCandidate(supabase, {
    candidate: safeCandidate,
    operatorId: staff.operator_id as string,
    ...(safePhotoUrls ? { photoUrls: safePhotoUrls } : {}),
    // Optional source label (truck/program). createDraftLotFromCandidate
    // normalizes (trim + 120-char cap) and persists to lots.source.
    ...(body.source !== undefined ? { source: body.source } : {}),
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }

  // PERF (2026-05-21): createDraftLotFromCandidate now returns
  // immediately and exposes background work (stock photo mirror +
  // product_lookups cache write-through) via an `enrich` thunk.
  //
  // On Cloudflare Workers the request handler must await any background
  // work it cares about — `void enrich()` would be killed when the
  // response is sent. Preserving the pre-2026-05-21 behavior is the
  // safest choice for this non-interactive HTTP endpoint: bulk
  // classifiers calling this expect a fully-enriched lot when the 200
  // returns. The response shape is unchanged (NextResponse.json drops
  // the `enrich` function field on serialization either way).
  await result.enrich();

  return NextResponse.json(result);
}
