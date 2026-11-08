// POST /api/cron/referral-credit-sweep
//
// Called hourly by the bingo-cron Worker. See
// lib/cron/referral-credit-sweep.ts (grants $5/$5 referral credits once the
// referred bidder's first invoice is paid AND picked up). Mig 0229.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runReferralCreditSweep } from '@/lib/cron/referral-credit-sweep';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runReferralCreditSweep();
  return NextResponse.json(result);
}
