// User account settings — distinct from /settings (which is the
// operator/business). This is the "my account" page: change password,
// see what auth methods are linked, etc. New here because Google-OAuth-
// only users had no UX path to set a password (the only existing path
// was /forgot-password, which sends an email subject to Supabase's free-
// tier rate limit and confuses anyone who has never had a password to
// reset in the first place).

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { AccountForm } from './AccountForm';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Surface which auth identities the user has linked so the page can
  // copy-clarify their options. user.identities is an array of provider
  // names: 'email', 'google', 'apple', etc.
  const identities = (user.identities ?? []).map((i) => i.provider);
  const hasPassword = identities.includes('email');
  const hasGoogle = identities.includes('google');
  const hasApple = identities.includes('apple');

  // Fetch the operator_users row so we can show/edit display_name.
  const { data: opUser } = await supabase
    .from('operator_users')
    .select('display_name')
    .eq('user_id', user.id)
    .maybeSingle();

  return (
    <div style={{ maxWidth: 540 }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Your account</h1>
      <p style={{ color: 'var(--fg-muted)', marginBottom: '2rem' }}>
        {user.email}
      </p>

      <AccountForm
        hasPassword={hasPassword}
        hasGoogle={hasGoogle}
        hasApple={hasApple}
        displayName={opUser?.display_name ?? null}
      />
    </div>
  );
}
