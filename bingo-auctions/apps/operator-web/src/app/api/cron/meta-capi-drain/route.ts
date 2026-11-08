// POST /api/cron/meta-capi-drain
// Called on a schedule by the bingo-cron Worker.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runMetaCapiDrain } from '@/lib/cron/meta-capi-drain';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runMetaCapiDrain();
  return NextResponse.json(result);
}
