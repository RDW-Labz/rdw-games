// POST /api/bidder/phone — bidder adds/updates their phone number
// (loyalty accounts are phone-keyed; also used for pickup texts).
// Clears square_synced_at so the hourly directory sync pushes the new
// phone to their Square customer profile.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body: { phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }

  const raw = typeof body.phone === 'string' ? body.phone.replace(/[^0-9+()\-\s]/g, '').trim().slice(0, 20) : '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return NextResponse.json({ ok: false, error: 'Enter a valid phone number.' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('bidders')
    .update({ phone: raw, square_synced_at: null })
    .eq('id', caller.userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
