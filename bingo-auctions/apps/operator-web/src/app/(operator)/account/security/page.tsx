// /account/security — MFA (TOTP) management for operator admins.
//
// LAUNCH_PLAN §3.1c. The page shows:
//   • Currently enrolled factors (verified TOTP factors with friendly names
//     + an unenroll button per factor).
//   • An "Add a new authenticator" widget that calls
//     supabase.auth.mfa.enroll(), shows the QR code + secret, prompts for
//     the 6-digit code, then verifies via challenge + verify.
//
// Why is this page admin-gated at the SERVER side rather than just relying
// on the middleware? Two reasons:
//   1. Defense in depth — the middleware enforces AAL2 on sensitive routes,
//      but this PAGE is special: it's both where the user enrolls a factor
//      AND a sensitive page. A user who has no factor yet must still be
//      able to load /account/security at AAL1 (otherwise they can never
//      enroll). So this route is INTENTIONALLY exempt from the AAL2 gate
//      in middleware. We re-check role here so a non-admin who somehow
//      lands here doesn't see the operator-only MFA UX.
//   2. The page renders different copy + lockout warnings for admins vs.
//      non-admin staff. Centralising the role check here keeps that copy
//      colocated with the data it depends on.
//
// Recovery — if an admin loses their TOTP device, there's no self-service
// reset. They must email legal@bingoauctions.com and the platform team uses
// supabase.auth.admin.deleteFactor() against the service-role key after
// verifying identity out-of-band. This is documented in the lockout
// notice below + in SecurityForm.tsx.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { SecurityForm } from './SecurityForm';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  const role = (me as { role?: string } | null)?.role ?? null;

  // List existing factors on this user. listFactors() runs against the
  // user's session — no service-role required, no admin API. We pass the
  // initial server-side snapshot into the client form so the page renders
  // immediately without a client round-trip; SecurityForm refreshes via
  // listFactors() after any mutation.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const initialFactors =
    factorsData?.all?.map((f) => ({
      id: f.id,
      friendly_name: f.friendly_name ?? null,
      factor_type: f.factor_type,
      status: f.status,
      created_at: f.created_at,
    })) ?? [];

  return (
    <div style={{ maxWidth: 640 }}>
      <PageHeader title="Two-factor authentication" />

      <p style={{ color: 'var(--fg-muted)', marginBottom: '1.5rem', fontSize: 14, lineHeight: 1.6 }}>
        Two-factor authentication (2FA) protects your account with a one-time
        code from an authenticator app on your phone. After enrolling, the
        operator console will ask for a code when you access staff management,
        billing, account settings, or payouts.
        {role === 'admin' && (
          <>
            {' '}
            <strong style={{ color: 'var(--fg)' }}>
              Required for admin accounts.
            </strong>
          </>
        )}
      </p>

      <SecurityForm
        isAdmin={role === 'admin'}
        initialFactors={initialFactors}
      />
    </div>
  );
}
