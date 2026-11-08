// POST /api/cron/payment-followups
// Called every 30 minutes by the bingo-cron Worker. Walks
// payment_followups (migration 0077) and sends 2nd reminders or
// marks invoices as no-show + relists their lots.
//
// See lib/cron/payment-followups.ts for the schedule logic.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runPaymentFollowups } from '@/lib/cron/payment-followups';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runPaymentFollowups();
  return NextResponse.json(result);
}
