// POST /api/cron/auto-charge-drain
// Called every minute by the bingo-cron Worker. See
// lib/cron/auto-charge-drain.ts for the worker logic (drains
// auto_charge_jobs by attempting off-session PaymentIntents).

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runAutoChargeDrain } from '@/lib/cron/auto-charge-drain';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runAutoChargeDrain();
  return NextResponse.json(result);
}
