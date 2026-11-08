// /account/security/step-up — AAL2 elevation challenge.
//
// LAUNCH_PLAN §3.1c. The middleware sends an admin user here when they
// try to access a sensitive route (`/staff`, `/billing`, `/account` (other
// than this subtree), `/payouts`) while their session is at AAL1 and they
// have at least one verified TOTP factor on file.
//
// This page is INTENTIONALLY exempt from the middleware's AAL2 gate —
// otherwise the user could never elevate (chicken-and-egg). The middleware
// allow-list checks `/account/security` and any sub-route, so both the
// enrollment page and this step-up page are reachable at AAL1.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { StepUpForm } from './StepUpForm';

export const dynamic = 'force-dynamic';

export default async function StepUpPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Find a verified TOTP factor to challenge against. If the user has
  // none, send them to the enrollment page first — the middleware
  // shouldn't have routed them here in that case, but we guard against
  // direct navigation.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const totpFactors = (factorsData?.all ?? []).filter(
    (f) => f.factor_type === 'totp' && f.status === 'verified',
  );

  if (totpFactors.length === 0) {
    redirect('/account/security');
  }

  // Validate returnTo to prevent open-redirect attacks via a crafted
  // ?returnTo=//evil.com or ?returnTo=https://evil.com. The path must
  // start with a single '/' AND not be a protocol-relative '//host'.
  function sanitiseReturnTo(raw: string | undefined): string {
    if (!raw) return '/dashboard';
    if (!raw.startsWith('/')) return '/dashboard';
    if (raw.startsWith('//')) return '/dashboard'; // protocol-relative
    return raw;
  }

  // If the user's session is already at AAL2 (e.g. they hit this page
  // directly after just stepping up), bounce them out — no second
  // challenge needed within the same session.
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalData?.currentLevel === 'aal2') {
    const params = await searchParams;
    redirect(sanitiseReturnTo(params.returnTo));
  }

  const params = await searchParams;
  const returnTo = sanitiseReturnTo(params.returnTo);

  return (
    <div style={{ maxWidth: 440, margin: '4rem auto' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Confirm it&apos;s you</h1>
      <p style={{ color: 'var(--fg-muted)', marginBottom: '1.5rem', fontSize: 14, lineHeight: 1.6 }}>
        Enter the 6-digit code from your authenticator app to continue. This
        extra step is required for sensitive actions like managing staff,
        billing, or your account settings.
      </p>
      <StepUpForm
        // Pick the most-recently-created factor as the default challenge
        // target. We render the form non-interactive about factor choice
        // since 99% of users will have one factor; if a future feature
        // adds multiple, the form can be extended to a picker.
        factorId={totpFactors[0]!.id}
        returnTo={returnTo}
      />
    </div>
  );
}
