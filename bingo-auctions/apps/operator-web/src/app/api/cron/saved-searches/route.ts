// POST /api/cron/saved-searches
// Called every 5 minutes by the bingo-cron Worker.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runSavedSearches } from '@/lib/cron/saved-searches';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runSavedSearches();
  return NextResponse.json(result);
}
