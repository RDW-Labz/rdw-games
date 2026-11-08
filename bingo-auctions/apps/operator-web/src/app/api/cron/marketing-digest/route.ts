// POST /api/cron/marketing-digest
//
// Called once daily by the bingo-cron Worker. See lib/marketing-digest.ts —
// runMarketingDigestAuto() self-gates (auto toggle ON + lots closing within
// 24h + last digest >72h old), so most days this is a no-op. Mig 0230.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runMarketingDigestAuto } from '@/lib/marketing-digest';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runMarketingDigestAuto();
  return NextResponse.json(result);
}
