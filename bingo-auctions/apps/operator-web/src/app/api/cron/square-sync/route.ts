// POST /api/cron/square-sync
//
// Called hourly by the bingo-cron Worker. See lib/cron/square-sync.ts —
// Square customer-directory sync + loyalty accrual, both gated on the
// /marketing toggles (platform_settings, mig 0236). No-op while both off.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runSquareSync } from '@/lib/cron/square-sync';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runSquareSync();
  return NextResponse.json(result);
}
