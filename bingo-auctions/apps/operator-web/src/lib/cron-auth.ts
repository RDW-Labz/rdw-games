// Shared-secret auth for /api/cron/* routes. The bingo-cron Worker is
// the only legitimate caller; everything else is rejected. The secret is
// set on both workers via Cloudflare env vars (CRON_SECRET).

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

export function checkCronSecret(req: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 503 });
  }
  const provided = req.headers.get('x-cron-secret') ?? '';
  // timingSafeEqual throws if buffers are different lengths, so guard first.
  // The length check itself is not timing-safe but it leaks only the secret
  // length (fixed, not secret-material), which is an acceptable trade-off.
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  const valid =
    expectedBuf.length === providedBuf.length &&
    timingSafeEqual(expectedBuf, providedBuf);
  if (!valid) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
