// POST /api/cron/feedback-notify — every 5 minutes from bingo-cron.
// Emails each new feedback item to the owners (burst-throttled). See
// lib/cron/feedback-notify.ts.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runFeedbackNotify } from '@/lib/cron/feedback-notify';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;
  return NextResponse.json(await runFeedbackNotify());
}
