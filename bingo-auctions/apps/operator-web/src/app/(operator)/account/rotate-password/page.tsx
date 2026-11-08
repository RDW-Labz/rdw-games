// /account/rotate-password — landed here by the operator layout when
// operator_users.force_password_rotate=TRUE (LAUNCH_PLAN §1.7).
//
// The user must pick a new password before continuing. No way out
// of this page except by setting a new password (or signing out from
// the form below + reauthenticating, which won't help because the
// flag is on the user row, not the session).

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { RotatePasswordForm } from './RotatePasswordForm';

export const dynamic = 'force-dynamic';

export default async function RotatePasswordPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Confirm the user is actually in the force-rotate state. If they got
  // here via a stale link after rotating, send them to /account.
  const { data: staff } = await supabase
    .from('operator_users')
    .select('force_password_rotate')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!staff?.['force_password_rotate']) {
    redirect('/account');
  }

  return (
    <div style={{ maxWidth: 480, margin: '4rem auto' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Set a new password</h1>
      <p style={{ color: 'var(--fg-muted)', marginBottom: '1.5rem', fontSize: 14 }}>
        Welcome to <strong>{user.email}</strong>. The admin who set up your
        account used a temporary password — pick your own now to continue.
      </p>
      <RotatePasswordForm />
    </div>
  );
}
