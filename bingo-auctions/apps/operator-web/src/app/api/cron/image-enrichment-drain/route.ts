// POST /api/cron/image-enrichment-drain
//
// Called every minute by the bingo-cron Worker. See
// lib/cron/image-enrichment-drain.ts for the worker logic (drains
// image_enrichment_jobs and writes resolved photo_url values back to
// import_rows / lots). Wires packages/image-enrichment (PR #133).

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runImageEnrichmentDrain } from '@/lib/cron/image-enrichment-drain';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runImageEnrichmentDrain();
  return NextResponse.json(result);
}
