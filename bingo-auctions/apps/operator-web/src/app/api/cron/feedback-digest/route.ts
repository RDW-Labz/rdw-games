// POST /api/cron/feedback-digest — every 30 minutes from bingo-cron; sends
// once per Chicago day in the 07:00 hour (the 07:30 tick retries a failure).

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runFeedbackDigest } from '@/lib/cron/feedback-notify';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;
  return NextResponse.json(await runFeedbackDigest());
}
