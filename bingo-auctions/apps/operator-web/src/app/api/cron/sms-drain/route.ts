// POST /api/cron/sms-drain
// Called every minute by the bingo-cron Worker.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runSmsDrain } from '@/lib/cron/sms-drain';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runSmsDrain();
  return NextResponse.json(result);
}
