// POST /api/cron/photo-rehost
//
// Called every minute by the bingo-cron Worker. See
// lib/cron/photo-rehost-drain.ts for the worker logic (downloads
// externally-hosted lot photos into the 'lot-photos' bucket and swaps
// lots.photo_urls to the internal copies). State columns from mig 0227.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runPhotoRehostDrain } from '@/lib/cron/photo-rehost-drain';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runPhotoRehostDrain();
  return NextResponse.json(result);
}
