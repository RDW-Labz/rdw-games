// POST /api/telemetry/signup-failure
//
// Fire-and-forget failure beacon from the signup forms (web + bidder app).
// Signups that Supabase Auth rejects (rate limits, weak passwords, provider
// outages) never create an auth.users row, so without this the operator has
// zero visibility into customers who tried to register and bounced — the
// 2026-07-04 "email rate limit exceeded" screenshot arrived via a customer's
// Facebook DM, not the platform.
//
// Unauthenticated by design: the caller is exactly the person who could NOT
// create an account. Abuse posture: writes are capped in size, the table is
// insert-only via service role, and reads are operator-staff-gated (mig 0223).
// Worst case a griefer inserts noise rows — annoying, not dangerous.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const SOURCES = new Set(['web', 'bidder-app']);

export async function POST(req: NextRequest) {
  let body: { email?: unknown; message?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.slice(0, 300).trim() : '';
  if (!message) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const email =
    typeof body.email === 'string' && body.email.length <= 254 ? body.email.trim() : null;
  const source =
    typeof body.source === 'string' && SOURCES.has(body.source) ? body.source : 'web';
  const userAgent = req.headers.get('user-agent')?.slice(0, 300) ?? null;

  const admin = getSupabaseAdmin();
  const { error } = await admin.from('signup_failures').insert({
    email,
    message,
    source,
    user_agent: userAgent,
  });
  if (error) {
    // Never surface DB errors to an anonymous beacon caller.
    console.error('[signup-failure] insert failed:', error.message);
  }
  return NextResponse.json({ ok: true });
}
