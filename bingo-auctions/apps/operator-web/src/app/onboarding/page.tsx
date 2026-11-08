// /onboarding — landing for signed-in users who aren't operator staff.
//
// The upstream platform had a full operator-onboarding wizard here (Stripe
// Connect + business profile). The BinGo fork removed that wizard — BinGo is
// single-operator — but ~30 operator pages still `redirect('/onboarding')`
// when the caller has no operator_users row, which 404'd until this page
// existed. Staff who land here by a stale link are bounced to the dashboard;
// everyone else gets told how to get access instead of a dead end.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';

export default async function OnboardingPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (staff) redirect('/dashboard');

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 480, textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.4rem', marginBottom: '0.75rem' }}>
          No staff access yet
        </h1>
        <p style={{ color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          You're signed in as <strong>{user.email}</strong>, but this account
          isn't linked to the BinGo Auctions operator team. Ask a BinGo admin
          to invite you from <strong>Staff</strong> in the operator console —
          the invite must use this exact email address.
        </p>
        <p style={{ color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          Looking to bid instead? Head to the{' '}
          <Link href="/">auction storefront</Link>.
        </p>
        <Link
          href="/login"
          style={{
            display: 'inline-block',
            padding: '0.55rem 1.1rem',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 6,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          Switch account
        </Link>
      </div>
    </main>
  );
}
