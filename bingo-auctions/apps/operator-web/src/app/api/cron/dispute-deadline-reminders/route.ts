// POST /api/cron/dispute-deadline-reminders
// Called every 30 minutes by the bingo-cron Worker.
// Finds open disputes whose evidence_due_by is within 48 hours and
// notifies operator admin/manager staff (dispute_evidence_due push).
//
// See lib/cron/dispute-deadline-reminders.ts for query + enqueue logic.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runDisputeDeadlineReminders } from '@/lib/cron/dispute-deadline-reminders';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runDisputeDeadlineReminders();
  return NextResponse.json(result);
}
