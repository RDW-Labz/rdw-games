// POST /api/cron/grace-expiry
// Called hourly by the bingo-cron Worker. See
// lib/cron/grace-expiry.ts for the worker logic (flips invoices in
// payment_failed_grace whose 48h window elapsed into
// payment_failed_relisted, applies the $5 relot fee, and releases
// the lots back into the auto-relist pool).

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runGraceExpiry } from '@/lib/cron/grace-expiry';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runGraceExpiry();
  return NextResponse.json(result);
}
