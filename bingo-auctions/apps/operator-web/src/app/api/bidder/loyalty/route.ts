// GET /api/bidder/loyalty — the signed-in bidder's Square Loyalty state for
// the profile card (mig 0237): points balance + the program's reward tiers
// (read live from Square, so the card always shows the real earn/redeem
// numbers). Returns { enabled: false, reason } when the feature is off or
// the bidder can't participate (no phone on file — loyalty accounts are
// phone-keyed).

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getLoyaltyProgramFull, findOrCreateLoyaltyAccount, getLoyaltyBalance } from '@/lib/square';
import { normalizePhoneE164 } from '@/lib/cron/square-sync';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ enabled: false, reason: 'unauthenticated' }, { status: 401 });

  const admin = getSupabaseAdmin();
  const { data: settings } = await admin
    .from('platform_settings')
    .select('square_loyalty_enabled')
    .eq('id', true)
    .maybeSingle();
  if (!settings?.square_loyalty_enabled) {
    return NextResponse.json({ enabled: false, reason: 'feature_off' });
  }

  const { data: bidder } = await admin
    .from('bidders')
    .select('phone')
    .eq('id', caller.userId)
    .maybeSingle();
  const phone = normalizePhoneE164((bidder?.phone as string | null) ?? null);
  if (!phone) return NextResponse.json({ enabled: false, reason: 'no_phone' });

  try {
    const program = await getLoyaltyProgramFull();
    if (!program || program.status !== 'ACTIVE') {
      return NextResponse.json({ enabled: false, reason: 'no_program' });
    }
    const accountId = await findOrCreateLoyaltyAccount(program.id, phone);
    const balance = await getLoyaltyBalance(accountId);
    return NextResponse.json({
      enabled: true,
      balance,
      terminology: program.terminology ?? { one: 'Point', other: 'Points' },
      tiers: program.tiers.map((t) => ({
        id: t.id,
        points: t.points,
        name: t.name,
        credit_cents: t.fixedCents, // null → in-store-only tier
      })),
    });
  } catch (err) {
    console.error('[bidder/loyalty] read failed:', (err as Error).message);
    return NextResponse.json({ enabled: false, reason: 'square_error' });
  }
}
