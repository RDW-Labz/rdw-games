// POST /api/cron/lot-categorize
// Called on a schedule by the bingo-cron Worker.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runLotCategorize } from '@/lib/cron/lot-categorize';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runLotCategorize();
  return NextResponse.json(result);
}
