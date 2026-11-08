// OAuth + email-link callback handler.
//
// Supabase redirects the user back here after they complete an OAuth
// provider flow (Google/Apple) or click a magic-link / email-confirm
// link. The URL contains a `code` query param that we exchange for a
// session via the server-side helper, which sets the auth cookies and
// then redirects.
//
// Routing rules (2026-05-22 two-domain split):
//
//   1. If ?next= is provided, honor it. Bidder signup forwards
//      ?next=/bidder/onboarding for first-time bidders so DOB + consent
//      collection happens after OAuth. Login uses ?next= to bounce back
//      to a deep link (e.g. /lot/CLR-000087).
//
//   2. Otherwise, route by user role:
//        - operator_users row exists → /dashboard
//        - bidders row exists  AND   default_payment_method_id IS NOT NULL
//                                    AND birth_date IS NOT NULL
//          → /browse (fully onboarded bidder)
//        - bidders row exists  but profile/payment still missing
//          → /bidder/onboarding (resume onboarding)
//        - no role row at all → /bidder/onboarding (treat as new bidder)
//
// The "default to bidder" rule is the post-split reality: bingoauctions.com
// is the public bidder marketplace, operators are invite-only, so any
// freshly-OAuth'd user with no role row is overwhelmingly more likely
// to be a new bidder than a new operator.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { safePostAuthPath } from '@/lib/bidder-onboarding-gate';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  // Validate before any redirect (#825): `new URL(next, req.url)` would honour
  // an absolute or protocol-relative destination. Signup intentionally sends
  // the `/bidder/onboarding?next=<destination>` wrapper, which is accepted
  // only when the nested destination is itself safe and non-looping.
  const next = safePostAuthPath(url.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=no_code', req.url));
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, req.url),
    );
  }

  // Explicit ?next= wins. Anything else routes by role.
  if (next) {
    return NextResponse.redirect(new URL(next, req.url));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // Operators first — they pay and the routing should not fail open to
  // /browse if the operator_users row is also present (rare, but a single
  // human could in theory have both identities).
  const { data: membership } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (membership) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  const { data: bidder } = await supabase
    .from('bidders')
    .select('id, birth_date, default_payment_method_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!bidder) {
    // Fresh OAuth user with no role row yet → bidder onboarding.
    return NextResponse.redirect(new URL('/bidder/onboarding', req.url));
  }

  // Bidder row exists — gate on the two columns place_bid checks.
  if (!bidder.birth_date || !bidder.default_payment_method_id) {
    return NextResponse.redirect(new URL('/bidder/onboarding', req.url));
  }

  return NextResponse.redirect(new URL('/browse', req.url));
}
