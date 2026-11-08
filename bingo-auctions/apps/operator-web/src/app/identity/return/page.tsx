// /identity/return — Stripe Identity redirect-back landing page.
//
// Parity target: apps/bidder-app/app/identity/verify.tsx post-WebBrowser flow
// (S14, Cluster D3).
//
// Stripe calls this URL after the bidder completes (or abandons) the hosted
// Identity flow. The webhook (identity.verification_session.verified) is the
// authoritative signal — it flips bidders.identity_verified_at. We poll
// that column here so the bidder gets immediate feedback rather than a
// "check back later" message.
//
// Flow on this page:
//   1. Server component checks auth + reads identity_verified_at.
//   2. Client component polls every 3s (max 10 attempts ≈ 30s).
//   3. On success: shows "Verified" state with link back to the originating
//      lot (from ?next= param, preserved by the verify page's cancel link).
//   4. On timeout: shows "Verification pending" with support contact and
//      a back link.
//
// The ?next= param is passed through from /identity/verify?next=… so that
// after a successful verification the bidder can return to the lot they
// were trying to bid on.
//
// Auth: same as /identity/verify — no hard middleware gate but server
// component checks defensively.

import { getSupabaseServer } from '@/lib/supabase-server';
import { IdentityReturnClient } from './IdentityReturnClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ next?: string }>;
}

export default async function IdentityReturnPage({ searchParams }: Props) {
  const { next } = await searchParams;

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // If there's no session the visitor may have arrived via a direct link
  // without a cookie. Show the pending state rather than crashing.
  let initialVerifiedAt: string | null = null;
  if (user) {
    const { data: bidderRow } = await supabase
      .from('bidders')
      .select('identity_verified_at')
      .eq('id', user.id)
      .maybeSingle();
    initialVerifiedAt = (bidderRow?.identity_verified_at as string | null) ?? null;
  }

  return (
    <IdentityReturnClient
      userId={user?.id ?? null}
      initialVerifiedAt={initialVerifiedAt}
      next={next ?? null}
    />
  );
}
