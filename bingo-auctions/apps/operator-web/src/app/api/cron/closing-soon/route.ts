// POST /api/cron/closing-soon
// Called every minute by the bingo-cron Worker.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runClosingSoon } from '@/lib/cron/closing-soon';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runClosingSoon();
  return NextResponse.json(result);
}
