// POST /api/telemetry/share-click — fire-and-forget beacon from the share
// affordances (lot ShareBar, profile ReferralCard, receipt WinShareCard).
// Counts clicks into share_clicks (mig 0232) for the /marketing scoreboard.
// Unauthenticated on purpose: signed-out visitors share lots too. The
// medium allowlist + length caps keep it a dumb counter, not an input.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const MEDIA = new Set([
  'copy',
  'facebook',
  'native',
  'referral_copy',
  'referral_native',
  'win_copy',
  'win_native',
]);

export async function POST(req: NextRequest) {
  let body: { medium?: string; lot_code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const medium = typeof body.medium === 'string' ? body.medium : '';
  if (!MEDIA.has(medium)) return NextResponse.json({ ok: false }, { status: 400 });

  const lotCode =
    typeof body.lot_code === 'string' && body.lot_code.length <= 32 ? body.lot_code : null;

  const admin = getSupabaseAdmin();
  await admin
    .from('share_clicks')
    .insert({ medium, lot_code: lotCode })
    .then(undefined, () => {
      // Telemetry must never surface an error to the sharer.
    });

  return NextResponse.json({ ok: true });
}
