// POST /api/cron/email-drain
// Called every minute by the bingo-cron Worker.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runEmailDrain } from '@/lib/cron/email-drain';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runEmailDrain();
  return NextResponse.json(result);
}
