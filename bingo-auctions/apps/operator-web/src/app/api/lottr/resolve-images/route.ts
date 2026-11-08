// POST /api/lottr/resolve-images  { upc?, asin?, isbn? }
//
// PHOTO-2: synchronous catalog-image resolver for the MOBILE lotting review
// card. The web Quick Lot path already calls resolveCatalogImages() inline
// before attaching a photo (lottr/quick/actions.ts); field-mobile had no
// equivalent, so a scanned / looked-up candidate whose catalog row carried no
// image_urls reached the review card with an empty stock photo. This endpoint
// exposes the same resolver to mobile: catalog read-through → free
// identifier-keyed enrichment (Amazon / Open Food Facts / Open Library /
// MusicBrainz) → self-warming write-back → returns the image URLs so the
// client can populate candidate.stockPhotos BEFORE opening the review card.
//
// Auth: cookie session (desktop) OR Bearer token (field-mobile) — same as the
// rest of /api/lottr/*. Uses the service-role `admin` client because the
// catalog write-back to product_lookups has no staff-write RLS policy
// (0028_security_fixes.sql) — identical justification to lookup-code.
//
// NOT AI-billed: the image-enrichment package probes only free identifier
// sources (no Sonar / LLM), so unlike lookup-code there is no checkAiBudget
// gate — matching the web actions.ts callers.

import { NextResponse } from 'next/server';
import { verifyLottrAuth } from '@/lib/lottr-auth';
import { resolveCatalogImages } from '@/lib/catalog/resolve-catalog-images';

export async function POST(req: Request) {
  const caller = await verifyLottrAuth(req);
  if (!caller) {
    return NextResponse.json(
      { ok: false, error: 'not_authenticated' },
      { status: 401 },
    );
  }

  let body: { upc?: string; asin?: string; isbn?: string };
  try {
    body = (await req.json()) as { upc?: string; asin?: string; isbn?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }

  const upc = typeof body.upc === 'string' ? body.upc.trim() : null;
  const asin = typeof body.asin === 'string' ? body.asin.trim() : null;
  const isbn = typeof body.isbn === 'string' ? body.isbn.trim() : null;
  if (!upc && !asin && !isbn) {
    return NextResponse.json(
      { ok: false, error: 'identifier required' },
      { status: 400 },
    );
  }

  try {
    // SERVICE-ROLE INTENTIONAL: resolveCatalogImages writes found images back
    // into product_lookups on a catalog miss (self-warming). 0028_security_fixes
    // dropped product_lookups_staff_write, so the write-back must use admin.
    const { imageUrls, outcome } = await resolveCatalogImages({
      admin: caller.admin,
      upc,
      asin,
      isbn,
      contributedByOperatorId: caller.operatorId,
    });
    return NextResponse.json({ ok: true, imageUrls, outcome });
  } catch (err) {
    // resolveCatalogImages never throws, but guard anyway so a transient
    // failure leaves the review card photo-less rather than 500ing the scan.
    console.error('[resolve-images] resolver error:', err);
    return NextResponse.json({ ok: true, imageUrls: [], outcome: 'miss' });
  }
}
