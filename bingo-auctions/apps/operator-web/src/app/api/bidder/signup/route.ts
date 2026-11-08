// POST /api/bidder/signup
//
// Server-authoritative bidder signup handler. Called from the Expo bidder app
// after supabase.auth.signUp() completes on the client. Responsibilities:
//
//   1. Verify the caller is authenticated (the fresh session token is forwarded).
//   2. Validate birth_date + age >= 18 (defense-in-depth on top of the DB trigger).
//   3. Insert the bidders row (service-role needed; the user has no prior row).
//   4. Record consent for each accepted policy via record_consent().
//
// The client must send a JSON body:
//   {
//     birth_date:      "YYYY-MM-DD",   // required
//     consent_slugs:   ["terms","privacy","bidder-agreement"],  // required
//     consent_method:  "signup_checkbox"  // required
//   }
//
// Returns { ok: true } or { ok: false, error: string }.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const ALLOWED_SLUGS = new Set(['terms', 'privacy', 'bidder-agreement']);

function calculateAge(birthDate: Date, now: Date): number {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age;
}

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);

  if (!caller) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }
  // Shape alignment with the pre-refactor variable name used later in this
  // file. `user` here is the caller, not Supabase's auth.User type.
  const user = {
    id: caller.userId,
    email: caller.email,
    display_name: caller.displayName,
  };

  let body: {
    birth_date?: string;
    consent_slugs?: string[];
    consent_method?: string;
    // Optional "Give $5, get $5" code (mig 0229). Invalid/unknown codes are
    // silently ignored — a typo must never block signup.
    referral_code?: string;
    // Optional phone (loyalty accounts are phone-keyed + pickup texts).
    phone?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { birth_date, consent_slugs, consent_method } = body;

  // --- Validate birth_date ---
  if (!birth_date || !/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) {
    return NextResponse.json({ ok: false, error: 'birth_date is required (YYYY-MM-DD)' }, { status: 400 });
  }
  const dob = new Date(birth_date + 'T00:00:00Z');
  if (isNaN(dob.getTime())) {
    return NextResponse.json({ ok: false, error: 'Invalid birth_date' }, { status: 400 });
  }
  const age = calculateAge(dob, new Date());
  if (age < 18) {
    return NextResponse.json(
      { ok: false, error: 'You must be at least 18 years old to create a bidder account.' },
      { status: 422 },
    );
  }

  // --- Validate consent_slugs ---
  if (!Array.isArray(consent_slugs) || consent_slugs.length === 0) {
    return NextResponse.json({ ok: false, error: 'consent_slugs is required' }, { status: 400 });
  }
  const invalidSlugs = consent_slugs.filter((s) => !ALLOWED_SLUGS.has(s));
  if (invalidSlugs.length > 0) {
    return NextResponse.json({ ok: false, error: `Unknown policy slugs: ${invalidSlugs.join(', ')}` }, { status: 400 });
  }

  if (!consent_method || typeof consent_method !== 'string') {
    return NextResponse.json({ ok: false, error: 'consent_method is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // --- Idempotency: skip if bidders row already exists ---
  const { data: existing } = await admin
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();

  // Resolve the referral code (if given) BEFORE the insert so referred_by
  // lands atomically with the new row. Self-referral is impossible here (the
  // referrer must already have a bidders row; the caller doesn't yet), but
  // the id inequality guard stays for the retry-on-existing path.
  let referredBy: string | null = null;
  const rawCode = typeof body.referral_code === 'string' ? body.referral_code.trim().toUpperCase() : '';
  if (rawCode && /^[A-Z0-9]{4,12}$/.test(rawCode)) {
    const { data: referrer } = await admin
      .from('bidders')
      .select('id')
      .eq('referral_code', rawCode)
      .maybeSingle();
    if (referrer && referrer.id !== user.id) referredBy = referrer.id as string;
  }

  const rawPhone = typeof body.phone === 'string' ? body.phone.replace(/[^0-9+()\-\s]/g, '').trim().slice(0, 20) : '';
  const phoneDigits = rawPhone.replace(/[^0-9]/g, '');
  const phone = phoneDigits.length >= 10 && phoneDigits.length <= 15 ? rawPhone : null;

  if (!existing) {
    const { error: insertErr } = await admin.from('bidders').insert({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      birth_date,
      ...(referredBy ? { referred_by: referredBy } : {}),
      ...(phone ? { phone } : {}),
    });

    if (insertErr) {
      // DB trigger fires here if age < 18 or birth_date missing — surface that.
      return NextResponse.json({ ok: false, error: insertErr.message }, { status: 422 });
    }
  } else if (referredBy) {
    // Row already existed (idempotent re-submit) — attach the referral only
    // if none was ever recorded. referred_by is set-once by design.
    await admin
      .from('bidders')
      .update({ referred_by: referredBy })
      .eq('id', user.id)
      .is('referred_by', null);
  }

  // --- Record consent for each policy ---
  // Fetch current published versions so we can record the exact version accepted.
  const { data: versions, error: versionsErr } = await admin
    .rpc('get_active_policy_versions');

  if (versionsErr || !versions) {
    // Policies not yet published (lawyer review pending). Record consent against
    // version=1 seed rows so the audit trail doesn't break signup flow.
    // This is acceptable because published=FALSE rows exist in policy_versions.
  }

  const versionMap = new Map<string, number>(
    (versions ?? []).map((v: { slug: string; version: number }) => [v.slug, v.version]),
  );

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null;
  const ua = req.headers.get('user-agent') ?? null;

  // Use service-role to insert consent rows (record_consent() RPC requires auth.uid()
  // which is available in the PostgREST context but not in the Edge/Node runtime).
  // Single bulk insert — all slugs in one round-trip instead of N sequential inserts.
  const consentRows = consent_slugs.map((slug) => ({
    user_id: user.id,
    slug,
    version: versionMap.get(slug) ?? 1,
    ip_address: ip,
    user_agent: ua,
    consent_method,
  }));
  const { error: consentErr } = await admin.from('terms_acceptances').insert(consentRows);
  if (consentErr) {
    // Non-fatal: log but don't block signup. The bidders row is already created.
    console.error('[bidder/signup] consent bulk insert failed:', consentErr.message);
  }

  return NextResponse.json({ ok: true });
}
