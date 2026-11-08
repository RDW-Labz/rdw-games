// POST /api/cron/operator-sub-lapse
// Called daily by the bingo-cron Worker. See
// lib/cron/operator-sub-lapse.ts for the worker logic (flips operators
// with subscription_status='past_due' and lapse_at < now() into
// status='subscription_lapsed' so downstream auction-creation gates
// can block them).

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runOperatorSubLapse } from '@/lib/cron/operator-sub-lapse';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runOperatorSubLapse();
  return NextResponse.json(result);
}
