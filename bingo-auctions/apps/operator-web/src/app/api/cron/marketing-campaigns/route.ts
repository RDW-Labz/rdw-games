// POST /api/cron/marketing-campaigns
//
// Called once daily by the bingo-cron Worker, in the same 14:00 UTC slot as the
// closing-soon digest. See lib/marketing-campaigns.ts —
// runMarketingCampaignsAuto() walks every ENABLED campaign and each one
// self-gates on its own cadence + per-bidder frequency cap, so most days this
// is a no-op. Every seeded campaign ships DISABLED (mig 0292), so until the
// owner turns one on in /marketing this route sends nothing at all.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runMarketingCampaignsAuto } from '@/lib/marketing-campaigns';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const results = await runMarketingCampaignsAuto();
  return NextResponse.json({
    campaigns: results.length,
    sent: results.filter((r) => r.sent).length,
    results,
  });
}
