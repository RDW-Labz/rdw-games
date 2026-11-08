// POST /api/cron/add-card-nudge
//
// Called hourly by the bingo-cron Worker. See lib/cron/add-card-nudge.ts
// (one-time "add a card to start bidding" email/push to bidders who
// registered >24h ago with no card on file). State column from mig 0228.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runAddCardNudge } from '@/lib/cron/add-card-nudge';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runAddCardNudge();
  return NextResponse.json(result);
}
