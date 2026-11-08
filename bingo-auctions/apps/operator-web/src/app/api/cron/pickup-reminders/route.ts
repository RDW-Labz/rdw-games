// POST /api/cron/pickup-reminders
// Called every 30 minutes by the bingo-cron Worker.
// Finds paid invoices whose pickup window closes within ~24 hours and
// notifies the bidder (pickup_reminder push) before the no-show timer fires.
//
// See lib/cron/pickup-reminders.ts for query + enqueue logic.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runPickupReminders } from '@/lib/cron/pickup-reminders';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runPickupReminders();
  return NextResponse.json(result);
}
