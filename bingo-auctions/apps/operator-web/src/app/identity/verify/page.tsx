// /identity/verify — web entry point for Stripe Identity verification.
//
// Parity target: apps/bidder-app/app/identity/verify.tsx (S14, Cluster D3).
//
// Flow:
//   1. Server component checks auth + bidder row.
//   2. If already verified → show already-verified state.
//   3. Otherwise → POSTs to /api/identity/verify (existing route, returns
//      { url, sessionId }). The route uses verifyAuth() which reads cookies
//      on the web path (getSupabaseServer session), so no Bearer token needed.
//   4. Redirects the browser to session.url (Stripe-hosted document + selfie
//      flow). return_url is /identity/return (hardcoded in the API route).
//   5. On completion, Stripe webhook flips bidders.identity_verified_at;
//      the return page polls until the column is non-null.
//
// This page uses a client component for the POST+redirect so the user gets
// immediate visual feedback ("Starting verification…") while the API call
// resolves. The server component pre-fetches identity_verified_at so
// already-verified bidders skip the spinner entirely.
//
// The ?next= param carries the originating URL so VerifyPageClient can
// pass it to /identity/return for the "back to lot" link after verification.
//
// Auth: middleware does NOT gate /identity/* (it's a flow page, not a
// profile page). The server component checks auth defensively.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { VerifyPageClient } from './VerifyPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ next?: string }>;
}

export default async function IdentityVerifyPage({ searchParams }: Props) {
  const { next } = await searchParams;

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const returnPath = next
      ? `/identity/verify?next=${encodeURIComponent(next)}`
      : '/identity/verify';
    redirect(`/login?next=${encodeURIComponent(returnPath)}`);
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id, identity_verified_at')
    .eq('id', user.id)
    .maybeSingle();

  if (!bidderRow) {
    const returnPath = next
      ? `/identity/verify?next=${encodeURIComponent(next)}`
      : '/identity/verify';
    redirect(`/bidder/onboarding?next=${encodeURIComponent(returnPath)}`);
  }

  return (
    <VerifyPageClient
      alreadyVerifiedAt={(bidderRow.identity_verified_at as string | null) ?? null}
      next={next ?? null}
    />
  );
}
