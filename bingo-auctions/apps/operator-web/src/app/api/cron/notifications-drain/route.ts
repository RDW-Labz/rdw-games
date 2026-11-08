// POST /api/cron/notifications-drain
// Called every minute by the bingo-cron Worker.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runNotificationsDrain } from '@/lib/cron/notifications-drain';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runNotificationsDrain();
  return NextResponse.json(result);
}
